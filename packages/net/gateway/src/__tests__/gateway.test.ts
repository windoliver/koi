/**
 * Unit tests for createGateway.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CLOSE_CODES } from "../close-codes.js";
import type { Gateway } from "../gateway.js";
import { createGateway } from "../gateway.js";
import type { SessionStore } from "../session-store.js";
import { createInMemorySessionStore } from "../session-store.js";
import type { GatewayFrame } from "../types.js";
import type { MockConnection, MockTransport } from "./test-utils.js";
import {
  createConnectMessage,
  createMockTransport,
  createTestAuthenticator,
  createTestFrame,
  createTestSession,
  resetTestSeqCounter,
  storeGet,
  storeHas,
  waitForCondition,
} from "./test-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function authenticateConn(
  transport: MockTransport,
  gateway: Gateway,
  sessionId: string,
  token = "test-token",
): Promise<MockConnection> {
  const conn = transport.simulateOpen();
  transport.simulateMessage(conn.id, createConnectMessage(token));
  await waitForCondition(() => storeHas(gateway.sessions(), sessionId));
  return conn;
}

function frameStr(overrides?: Partial<GatewayFrame>): string {
  return JSON.stringify(createTestFrame(overrides));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createGateway", () => {
  let transport: MockTransport;
  let gateway: Gateway;

  beforeEach(() => {
    transport = createMockTransport();
    resetTestSeqCounter();
  });

  afterEach(async () => {
    await gateway.stop();
  });

  // =========================================================================
  // Construction
  // =========================================================================

  describe("factory construction", () => {
    test("returns gateway with all expected methods", () => {
      gateway = createGateway({}, { transport, auth: createTestAuthenticator() });
      expect(typeof gateway.start).toBe("function");
      expect(typeof gateway.stop).toBe("function");
      expect(typeof gateway.sessions).toBe("function");
      expect(typeof gateway.onFrame).toBe("function");
      expect(typeof gateway.send).toBe("function");
      expect(typeof gateway.dispatch).toBe("function");
      expect(typeof gateway.destroySession).toBe("function");
      expect(typeof gateway.onSessionEvent).toBe("function");
    });

    test("uses provided store", () => {
      const store = createInMemorySessionStore();
      gateway = createGateway({}, { transport, auth: createTestAuthenticator(), store });
      expect(gateway.sessions()).toBe(store);
    });
  });

  // =========================================================================
  // Connection limits
  // =========================================================================

  describe("maxConnections", () => {
    test("rejects connection when limit exceeded", async () => {
      const auth = createTestAuthenticator();
      gateway = createGateway({ maxConnections: 2 }, { transport, auth });
      await gateway.start(0);

      transport.simulateOpen();
      transport.simulateOpen();
      const rejected = transport.simulateOpen();

      expect(rejected.closed).toBe(true);
      expect(rejected.closeCode).toBe(CLOSE_CODES.MAX_CONNECTIONS);
    });
  });

  // =========================================================================
  // Auth + session lifecycle
  // =========================================================================

  describe("session lifecycle", () => {
    test("creates session after successful auth", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "sess-abc",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      await authenticateConn(transport, gateway, "sess-abc");

      expect(storeHas(gateway.sessions(), "sess-abc")).toBe(true);
    });

    test("emits 'created' session event", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-ev1",
        agentId: "a1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const events: string[] = [];
      gateway.onSessionEvent((ev) => events.push(ev.kind));

      await authenticateConn(transport, gateway, "s-ev1");
      expect(events).toContain("created");
    });

    test("destroys session live connection on close but retains store record for reconnect replay protection", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-close",
        agentId: "a1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const conn = await authenticateConn(transport, gateway, "s-close");
      let destroyedEvent = false;
      gateway.onSessionEvent((ev) => {
        if (ev.kind === "destroyed" && ev.sessionId === "s-close") destroyedEvent = true;
      });
      transport.simulateClose(conn.id);

      // Session record is retained to preserve remoteSeq for reconnect replay protection.
      await waitForCondition(() => destroyedEvent);
      expect(storeHas(gateway.sessions(), "s-close")).toBe(true);
    });

    test("emits 'destroyed' session event on close", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-ev2",
        agentId: "a1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const events: string[] = [];
      gateway.onSessionEvent((ev) => events.push(ev.kind));

      const conn = await authenticateConn(transport, gateway, "s-ev2");
      transport.simulateClose(conn.id);

      await waitForCondition(() => events.includes("destroyed"));
      expect(events).toContain("destroyed");
    });

    test("failed auth does not create session", async () => {
      const auth = createTestAuthenticator({ ok: false, code: "INVALID_TOKEN", message: "bad" });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, createConnectMessage("bad-token"));

      await new Promise((r) => setTimeout(r, 100));
      expect(gateway.sessions().size()).toBe(0);
    });
  });

  // =========================================================================
  // Frame dispatch
  // =========================================================================

  describe("frame dispatch", () => {
    test("onFrame handler is called for each received frame", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-frame",
        agentId: "a1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const received: GatewayFrame[] = [];
      gateway.onFrame((_sess, frame) => received.push(frame));

      const conn = await authenticateConn(transport, gateway, "s-frame");
      transport.simulateMessage(conn.id, frameStr({ seq: 0 }));
      transport.simulateMessage(conn.id, frameStr({ seq: 1 }));

      await waitForCondition(() => received.length >= 2);
      expect(received.map((f) => f.seq)).toEqual([0, 1]);
    });

    test("duplicate frames are acked but not dispatched", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-dedup",
        agentId: "a1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const received: GatewayFrame[] = [];
      gateway.onFrame((_sess, frame) => received.push(frame));

      const conn = await authenticateConn(transport, gateway, "s-dedup");
      const frameJson = frameStr({ seq: 0, id: "dup-frame" });
      transport.simulateMessage(conn.id, frameJson);
      transport.simulateMessage(conn.id, frameJson); // duplicate

      await waitForCondition(() => received.length >= 1);
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(1);
    });

    test("onFrame unsubscribe stops delivery", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-unsub",
        agentId: "a1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const received: GatewayFrame[] = [];
      const unsub = gateway.onFrame((_sess, frame) => received.push(frame));

      const conn = await authenticateConn(transport, gateway, "s-unsub");
      transport.simulateMessage(conn.id, frameStr({ seq: 0 }));
      await waitForCondition(() => received.length >= 1);

      unsub();
      transport.simulateMessage(conn.id, frameStr({ seq: 1 }));
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(1); // only the first frame
    });

    test("concurrent frames from same socket are serialized — no remoteSeq regression", async () => {
      // Use a slow store to ensure the second frame's message handler fires before
      // the first frame's store.set() resolves. Without per-connection serialization
      // the second store.set() could overwrite remoteSeq with a stale value.
      const base = createInMemorySessionStore();
      let setDelay = 0;
      const slowStore: SessionStore = {
        get: (id) => base.get(id),
        set: (session) => {
          const delay = setDelay;
          setDelay = 0; // one-shot delay for first frame only
          if (delay === 0) return base.set(session);
          return new Promise((resolve) =>
            setTimeout(() => resolve(Promise.resolve(base.set(session))), delay),
          );
        },
        has: (id) => base.has(id),
        delete: (id) => base.delete(id),
        size: () => base.size(),
        entries: () => base.entries(),
      };

      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-serial",
        agentId: "a1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth, store: slowStore });
      await gateway.start(0);

      const received: GatewayFrame[] = [];
      gateway.onFrame((_sess, frame) => received.push(frame));

      const conn = await authenticateConn(transport, gateway, "s-serial");

      // Inject a 30 ms delay on the NEXT store.set() (first real frame)
      setDelay = 30;
      transport.simulateMessage(conn.id, frameStr({ seq: 0 }));
      transport.simulateMessage(conn.id, frameStr({ seq: 1 })); // arrives before first store.set resolves

      await waitForCondition(() => received.length >= 2);

      // Both frames dispatched in order
      expect(received.map((f) => f.seq)).toEqual([0, 1]);
      // remoteSeq reflects both frames (not regressed back to 1)
      const stored = storeGet(gateway.sessions(), "s-serial");
      expect(stored?.remoteSeq).toBe(2);
    });

    test("malformed frame sends error response, not dispatched", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-bad",
        agentId: "a1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const received: GatewayFrame[] = [];
      gateway.onFrame((_sess, frame) => received.push(frame));

      const conn = await authenticateConn(transport, gateway, "s-bad");
      transport.simulateMessage(conn.id, "{not valid json}");

      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(0);
      const errorMsg = conn.sent.find((s) => {
        const p = JSON.parse(s) as Record<string, unknown>;
        return p.kind === "error";
      });
      expect(errorMsg).toBeDefined();
    });
  });

  // =========================================================================
  // send()
  // =========================================================================

  describe("send", () => {
    test("returns error for unknown sessionId", () => {
      gateway = createGateway({}, { transport, auth: createTestAuthenticator() });
      const r = gateway.send("nonexistent", createTestFrame());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
    });

    test("sends encoded frame to connection", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-send",
        agentId: "a1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const conn = await authenticateConn(transport, gateway, "s-send");
      const sentBefore = conn.sent.length;

      const frame = createTestFrame({ seq: 99 });
      const r = gateway.send("s-send", frame);
      expect(r.ok).toBe(true);
      expect(conn.sent.length).toBeGreaterThan(sentBefore);
    });
  });

  // =========================================================================
  // dispatch()
  // =========================================================================

  describe("dispatch", () => {
    test("routes frame to all onFrame handlers", () => {
      gateway = createGateway({}, { transport, auth: createTestAuthenticator() });
      const received: GatewayFrame[] = [];
      gateway.onFrame((_s, f) => received.push(f));

      const session = createTestSession();
      const frame = createTestFrame({ seq: 42 });
      gateway.dispatch(session, frame);

      expect(received).toHaveLength(1);
      expect(received[0]?.seq).toBe(42);
    });
  });

  // =========================================================================
  // destroySession()
  // =========================================================================

  describe("destroySession", () => {
    test("succeeds (idempotent) for unknown session", () => {
      gateway = createGateway({}, { transport, auth: createTestAuthenticator() });
      const r = gateway.destroySession("missing");
      expect(r.ok).toBe(true);
    });

    test("purges disconnected session from store without live connection", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-disc-purge",
        agentId: "a1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const conn = await authenticateConn(transport, gateway, "s-disc-purge");
      transport.simulateClose(conn.id); // disconnect — session stays in store
      await waitForCondition(
        () =>
          !gateway.sessions().has("s-disc-purge") || storeHas(gateway.sessions(), "s-disc-purge"),
      );
      expect(storeHas(gateway.sessions(), "s-disc-purge")).toBe(true); // retained

      gateway.destroySession("s-disc-purge");
      await waitForCondition(() => !storeHas(gateway.sessions(), "s-disc-purge"));
      expect(storeHas(gateway.sessions(), "s-disc-purge")).toBe(false);
    });

    test("closes connection with ADMIN_CLOSED code", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-destroy",
        agentId: "a1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const conn = await authenticateConn(transport, gateway, "s-destroy");
      const r = gateway.destroySession("s-destroy", "test teardown");

      expect(r.ok).toBe(true);
      expect(conn.closed).toBe(true);
      expect(conn.closeCode).toBe(CLOSE_CODES.ADMIN_CLOSED);
    });

    test("purges session from store on destroySession", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-destroy-purge",
        agentId: "a1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      await authenticateConn(transport, gateway, "s-destroy-purge");
      expect(storeHas(gateway.sessions(), "s-destroy-purge")).toBe(true);

      gateway.destroySession("s-destroy-purge", "cleanup");
      await waitForCondition(() => !storeHas(gateway.sessions(), "s-destroy-purge"));
      expect(storeHas(gateway.sessions(), "s-destroy-purge")).toBe(false);
    });
  });

  // =========================================================================
  // Session event unsubscribe
  // =========================================================================

  describe("onSessionEvent unsubscribe", () => {
    test("stops delivering events after unsubscribe", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-unsub-ev",
        agentId: "a1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const events: string[] = [];
      const unsub = gateway.onSessionEvent((ev) => events.push(ev.kind));
      unsub(); // unsubscribe immediately

      await authenticateConn(transport, gateway, "s-unsub-ev");
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toHaveLength(0);
    });
  });
});
