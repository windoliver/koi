/**
 * Unit tests for the gateway factory (createGateway).
 *
 * These tests complement the integration tests in gateway.integration.test.ts
 * by focusing on isolated, single-behavior verification of each gateway method
 * and lifecycle path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Gateway } from "../gateway.js";
import { createGateway } from "../gateway.js";
import { createInMemorySessionStore } from "../session-store.js";
import type { GatewayFrame, RoutingConfig, Session } from "../types.js";
import type { MockConnection, MockTransport } from "./test-utils.js";
import {
  createConnectMessage,
  createMockTransport,
  createTestAuthenticator,
  createTestFrame,
  createTestSession,
  resetTestSeqCounter,
  storeHas,
  waitForCondition,
} from "./test-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Complete the auth handshake on a connection and wait for the session to appear. */
async function authenticateConnection(
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

/** Build a JSON-encoded frame string suitable for simulateMessage. */
function frameString(overrides?: Partial<GatewayFrame>): string {
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
  // 1. Factory — basic construction
  // =========================================================================

  describe("factory construction", () => {
    test("creates with default config and returns a valid gateway", async () => {
      const auth = createTestAuthenticator();
      gateway = createGateway({}, { transport, auth });

      expect(gateway.start).toBeFunction();
      expect(gateway.stop).toBeFunction();
      expect(gateway.sessions).toBeFunction();
      expect(gateway.onFrame).toBeFunction();
      expect(gateway.send).toBeFunction();
      expect(gateway.dispatch).toBeFunction();
      expect(gateway.webhookPort).toBeFunction();
    });

    test("creates with custom config overrides", async () => {
      const auth = createTestAuthenticator();
      gateway = createGateway({ maxConnections: 5, authTimeoutMs: 1000 }, { transport, auth });
      await gateway.start(0);

      // With maxConnections: 5, we can open 5 connections without rejection
      const conns: readonly MockConnection[] = Array.from({ length: 5 }, () =>
        transport.simulateOpen(),
      );
      expect(conns.every((c) => !c.closed)).toBe(true);

      // The 6th exceeds the limit
      const rejected = transport.simulateOpen();
      expect(rejected.closed).toBe(true);
      expect(rejected.closeCode).toBe(4005);
    });

    test("uses provided SessionStore instead of default", async () => {
      const customStore = createInMemorySessionStore();
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "custom-s1",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth, store: customStore });
      await gateway.start(0);

      await authenticateConnection(transport, gateway, "custom-s1");

      expect(customStore.has("custom-s1")).toEqual({ ok: true, value: true });
    });

    test("sessions() returns the store", () => {
      const customStore = createInMemorySessionStore();
      const auth = createTestAuthenticator();
      gateway = createGateway({}, { transport, auth, store: customStore });

      expect(gateway.sessions()).toBe(customStore);
    });

    test("webhookPort() returns undefined when webhook is not configured", () => {
      const auth = createTestAuthenticator();
      gateway = createGateway({}, { transport, auth });

      expect(gateway.webhookPort()).toBeUndefined();
    });
  });

  // =========================================================================
  // 2. Frame handler registration (onFrame)
  // =========================================================================

  describe("onFrame", () => {
    test("registered handler is called when a frame is dispatched", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-handler",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const received: readonly GatewayFrame[] = [];
      const mutableReceived = received as GatewayFrame[];
      gateway.onFrame((_session, frame) => {
        mutableReceived.push(frame);
      });

      const conn = await authenticateConnection(transport, gateway, "s-handler");
      transport.simulateMessage(conn.id, frameString({ seq: 0 }));
      await waitForCondition(() => received.length >= 1);

      expect(received).toHaveLength(1);
    });

    test("multiple handlers all receive the same frame", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-multi",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const received1: GatewayFrame[] = [];
      const received2: GatewayFrame[] = [];
      const received3: GatewayFrame[] = [];

      gateway.onFrame((_s, f) => received1.push(f));
      gateway.onFrame((_s, f) => received2.push(f));
      gateway.onFrame((_s, f) => received3.push(f));

      const conn = await authenticateConnection(transport, gateway, "s-multi");
      transport.simulateMessage(conn.id, frameString({ seq: 0 }));
      await waitForCondition(() => received1.length >= 1);

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
      expect(received3).toHaveLength(1);
      // All handlers received the same frame id
      expect(received1[0]?.id).toBe(received2[0]?.id);
      expect(received2[0]?.id).toBe(received3[0]?.id);
    });

    test("handler throwing does not crash gateway or block other handlers", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-throw",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const received: GatewayFrame[] = [];

      // First handler: throws
      gateway.onFrame(() => {
        throw new Error("Intentional handler error");
      });
      // Second handler: should still be called
      gateway.onFrame((_s, f) => received.push(f));

      const conn = await authenticateConnection(transport, gateway, "s-throw");
      transport.simulateMessage(conn.id, frameString({ seq: 0 }));
      await waitForCondition(() => received.length >= 1);

      expect(received).toHaveLength(1);
    });

    test("unsubscribe function removes handler", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-unsub",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const received: GatewayFrame[] = [];
      const unsub = gateway.onFrame((_s, f) => received.push(f));

      const conn = await authenticateConnection(transport, gateway, "s-unsub");
      unsub();

      transport.simulateMessage(conn.id, frameString({ seq: 0 }));
      // Wait for the ack to be sent (proves the frame was processed by the gateway)
      await waitForCondition(() => conn.sent.length >= 2);

      expect(received).toHaveLength(0);
    });

    test("handler not called after unsubscribe even when other handlers exist", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-unsub2",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const receivedA: GatewayFrame[] = [];
      const receivedB: GatewayFrame[] = [];

      const unsubA = gateway.onFrame((_s, f) => receivedA.push(f));
      gateway.onFrame((_s, f) => receivedB.push(f));

      unsubA();

      const conn = await authenticateConnection(transport, gateway, "s-unsub2");
      transport.simulateMessage(conn.id, frameString({ seq: 0 }));
      await waitForCondition(() => receivedB.length >= 1);

      expect(receivedA).toHaveLength(0);
      expect(receivedB).toHaveLength(1);
    });
  });

  // =========================================================================
  // 3. send() method
  // =========================================================================

  describe("send()", () => {
    test("returns NOT_FOUND error for unknown sessionId", () => {
      const auth = createTestAuthenticator();
      gateway = createGateway({}, { transport, auth });

      const result = gateway.send("nonexistent", createTestFrame());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
        expect(result.error.message).toBe("Session not connected");
      }
    });

    test("returns error when conn.send() returns 0 (dropped)", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-drop",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      // Connection with sendResult: 0 always reports dropped
      const conn = transport.simulateOpen({ sendResult: 0 });
      transport.simulateMessage(conn.id, createConnectMessage());
      await waitForCondition(() => storeHas(gateway.sessions(), "s-drop"));

      const result = gateway.send("s-drop", createTestFrame());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INTERNAL");
        expect(result.error.message).toContain("dropped");
      }
    });

    test("tracks backpressure when conn.send() returns -1", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-bp",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      // Connection with sendResult: -1 simulates backpressure
      const conn = transport.simulateOpen({ sendResult: -1 });
      transport.simulateMessage(conn.id, createConnectMessage());
      await waitForCondition(() => storeHas(gateway.sessions(), "s-bp"));

      const result = gateway.send("s-bp", createTestFrame());

      // -1 is still a "success" from the gateway's perspective (frame queued)
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(-1);
      }
    });

    test("returns byte count on successful send", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-ok",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      await authenticateConnection(transport, gateway, "s-ok");

      const result = gateway.send("s-ok", createTestFrame());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeGreaterThan(0);
      }
    });
  });

  // =========================================================================
  // 4. dispatch() method
  // =========================================================================

  describe("dispatch()", () => {
    test("calls all registered frame handlers", () => {
      const auth = createTestAuthenticator();
      gateway = createGateway({}, { transport, auth });

      const received: Array<{ readonly session: Session; readonly frame: GatewayFrame }> = [];
      const mutableReceived = received as Array<{ session: Session; frame: GatewayFrame }>;

      gateway.onFrame((session, frame) => {
        mutableReceived.push({ session, frame });
      });

      const session = createTestSession({ agentId: "dispatch-agent" });
      const frame = createTestFrame({ payload: { dispatched: true } });

      gateway.dispatch(session, frame);

      expect(received).toHaveLength(1);
      expect(received[0]?.frame.payload).toEqual({ dispatched: true });
    });

    test("resolves routing when routing config is present", () => {
      const routingConfig: RoutingConfig = {
        scopingMode: "per-channel-peer",
        bindings: [{ pattern: "slack:*", agentId: "slack-bot" }],
      };
      const auth = createTestAuthenticator();
      gateway = createGateway({ routing: routingConfig }, { transport, auth });

      const receivedSessions: Session[] = [];
      gateway.onFrame((session) => {
        receivedSessions.push(session);
      });

      const session = createTestSession({
        agentId: "default-agent",
        routing: { channel: "slack", peer: "user1" },
      });
      gateway.dispatch(session, createTestFrame());

      expect(receivedSessions).toHaveLength(1);
      expect(receivedSessions[0]?.agentId).toBe("slack-bot");
    });

    test("uses auth agentId when no routing match", () => {
      const routingConfig: RoutingConfig = {
        scopingMode: "per-channel-peer",
        bindings: [{ pattern: "discord:*", agentId: "discord-bot" }],
      };
      const auth = createTestAuthenticator();
      gateway = createGateway({ routing: routingConfig }, { transport, auth });

      const receivedSessions: Session[] = [];
      gateway.onFrame((session) => {
        receivedSessions.push(session);
      });

      const session = createTestSession({
        agentId: "fallback-agent",
        routing: { channel: "slack", peer: "user1" },
      });
      gateway.dispatch(session, createTestFrame());

      expect(receivedSessions).toHaveLength(1);
      expect(receivedSessions[0]?.agentId).toBe("fallback-agent");
    });

    test("handles no routing config (backward compat)", () => {
      const auth = createTestAuthenticator();
      gateway = createGateway({}, { transport, auth });

      const receivedSessions: Session[] = [];
      gateway.onFrame((session) => {
        receivedSessions.push(session);
      });

      const session = createTestSession({ agentId: "original-agent" });
      gateway.dispatch(session, createTestFrame());

      expect(receivedSessions).toHaveLength(1);
      expect(receivedSessions[0]?.agentId).toBe("original-agent");
    });
  });

  // =========================================================================
  // 5. Connection lifecycle
  // =========================================================================

  describe("connection lifecycle", () => {
    test("onOpen registers connection and allows auth handshake", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-open",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const conn = transport.simulateOpen();
      expect(conn.closed).toBe(false);

      transport.simulateMessage(conn.id, createConnectMessage());
      await waitForCondition(() => storeHas(gateway.sessions(), "s-open"));

      expect(gateway.sessions().has("s-open")).toEqual({ ok: true, value: true });
    });

    test("rejects when maxConnections exceeded (close 4005)", async () => {
      const auth = createTestAuthenticator();
      gateway = createGateway({ maxConnections: 1 }, { transport, auth });
      await gateway.start(0);

      // First connection is fine
      const conn1 = transport.simulateOpen();
      expect(conn1.closed).toBe(false);

      // Second connection exceeds limit (transport reports 2 connections > maxConnections=1)
      const conn2 = transport.simulateOpen();
      expect(conn2.closed).toBe(true);
      expect(conn2.closeCode).toBe(4005);
    });

    test("rejects when global buffer limit exceeded (close 4006)", async () => {
      const auth = createTestAuthenticator();
      gateway = createGateway({ globalBufferLimitBytes: 0 }, { transport, auth });
      await gateway.start(0);

      const conn = transport.simulateOpen();

      expect(conn.closed).toBe(true);
      expect(conn.closeCode).toBe(4006);
    });

    test("cleanup removes session from store on close", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-cleanup",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const conn = await authenticateConnection(transport, gateway, "s-cleanup");
      expect(gateway.sessions().has("s-cleanup")).toEqual({ ok: true, value: true });

      transport.simulateClose(conn.id);

      expect(gateway.sessions().has("s-cleanup")).toEqual({ ok: true, value: false });
    });

    test("auth timeout closes with 4001", async () => {
      const auth = createTestAuthenticator();
      gateway = createGateway({ authTimeoutMs: 50 }, { transport, auth });
      await gateway.start(0);

      const conn = transport.simulateOpen();
      // Do NOT send a connect message -- let the timeout fire

      await waitForCondition(() => conn.closed, 2000);

      expect(conn.closed).toBe(true);
      expect(conn.closeCode).toBe(4001);
    });
  });

  // =========================================================================
  // 6. Post-handshake frame handling
  // =========================================================================

  describe("post-handshake frame handling", () => {
    test("invalid JSON sends error frame (not close)", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-json",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const conn = await authenticateConnection(transport, gateway, "s-json");
      const sentBefore = conn.sent.length;

      transport.simulateMessage(conn.id, "{not valid json!!!");
      await waitForCondition(() => conn.sent.length > sentBefore);

      // Connection should NOT be closed
      expect(conn.closed).toBe(false);

      // Last sent message should be an error frame
      const lastMsg = JSON.parse(conn.sent[conn.sent.length - 1] as string) as Record<
        string,
        unknown
      >;
      expect(lastMsg.kind).toBe("error");
    });

    test("duplicate seq sends ack (idempotent)", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-dup",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const dispatched: GatewayFrame[] = [];
      gateway.onFrame((_s, f) => dispatched.push(f));

      const conn = await authenticateConnection(transport, gateway, "s-dup");

      const frame = frameString({ id: "dup-id", seq: 0 });
      transport.simulateMessage(conn.id, frame);
      await waitForCondition(() => dispatched.length >= 1);

      // Send the same frame again (duplicate seq + id)
      transport.simulateMessage(conn.id, frame);
      // Wait for the ack to be sent for the duplicate
      await waitForCondition(() => conn.sent.length >= 3); // handshake ack + first ack + dup ack

      // Dispatched only once
      expect(dispatched).toHaveLength(1);

      // The duplicate ack should reference the same frame id
      const dupAck = JSON.parse(conn.sent[conn.sent.length - 1] as string) as Record<
        string,
        unknown
      >;
      expect(dupAck.kind).toBe("ack");
      expect(dupAck.ref).toBe("dup-id");
    });

    test("out-of-window seq sends error frame", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-oow",
        agentId: "agent-1",
        metadata: {},
      });
      // dedupWindowSize: 4 means seq 4+ is out of window when nextExpected is 0
      gateway = createGateway({ dedupWindowSize: 4 }, { transport, auth });
      await gateway.start(0);

      const conn = await authenticateConnection(transport, gateway, "s-oow");
      const sentBefore = conn.sent.length;

      // Send a frame with seq way beyond the window
      transport.simulateMessage(conn.id, frameString({ seq: 100 }));
      await waitForCondition(() => conn.sent.length > sentBefore);

      const lastMsg = JSON.parse(conn.sent[conn.sent.length - 1] as string) as Record<
        string,
        unknown
      >;
      expect(lastMsg.kind).toBe("error");
      const payload = lastMsg.payload as Record<string, unknown>;
      expect(payload.message).toContain("out of window");
    });

    test("session missing mid-message closes with 4008", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-gone",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const conn = await authenticateConnection(transport, gateway, "s-gone");

      // Manually remove session from store (simulates session disappearing)
      gateway.sessions().delete("s-gone");

      transport.simulateMessage(conn.id, frameString({ seq: 0 }));
      await new Promise((r) => setTimeout(r, 0));

      expect(conn.closed).toBe(true);
      expect(conn.closeCode).toBe(4008);
    });

    test("backpressure critical drops frames silently", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-bp-drop",
        agentId: "agent-1",
        metadata: {},
      });
      // Tiny buffer: 10 bytes max, so any frame puts it into critical
      gateway = createGateway(
        {
          maxBufferBytesPerConnection: 10,
          backpressureHighWatermark: 0.5,
          backpressureCriticalTimeoutMs: 60_000, // long timeout so we don't hit 4009
        },
        { transport, auth },
      );
      await gateway.start(0);

      const dispatched: GatewayFrame[] = [];
      gateway.onFrame((_s, f) => dispatched.push(f));

      const conn = await authenticateConnection(transport, gateway, "s-bp-drop");
      const sentAfterAuth = conn.sent.length;

      // First frame will push buffer into critical (JSON > 10 bytes)
      transport.simulateMessage(conn.id, frameString({ seq: 0 }));
      await waitForCondition(() => dispatched.length >= 1);

      // Second frame should be dropped (critical state)
      transport.simulateMessage(conn.id, frameString({ seq: 1 }));

      // Give it time to process (should not dispatch)
      await new Promise((r) => setTimeout(r, 50));

      expect(dispatched).toHaveLength(1);
      // No ack or error frame sent for the dropped frame beyond what was sent for seq 0
      // The conn.sent grows only for the first frame's ack
      const sentAfterFrames = conn.sent.length;
      expect(sentAfterFrames).toBe(sentAfterAuth + 1); // only 1 ack for seq 0
    });

    test("backpressure critical timeout closes with 4009", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-bp-timeout",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway(
        {
          maxBufferBytesPerConnection: 10,
          backpressureHighWatermark: 0.5,
          backpressureCriticalTimeoutMs: 50, // very short
        },
        { transport, auth },
      );
      await gateway.start(0);

      const conn = await authenticateConnection(transport, gateway, "s-bp-timeout");

      // First frame pushes into critical
      transport.simulateMessage(conn.id, frameString({ seq: 0 }));

      // Wait for critical timeout to expire
      await new Promise((r) => setTimeout(r, 100));

      // Next frame triggers the timeout check
      transport.simulateMessage(conn.id, frameString({ seq: 1 }));
      await new Promise((r) => setTimeout(r, 0));

      expect(conn.closed).toBe(true);
      expect(conn.closeCode).toBe(4009);
    });
  });

  // =========================================================================
  // 7. stop() method
  // =========================================================================

  describe("stop()", () => {
    test("closes all connections with 1001", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-stop1",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const conn1 = await authenticateConnection(transport, gateway, "s-stop1");

      await gateway.stop();

      expect(conn1.closed).toBe(true);
      expect(conn1.closeCode).toBe(1001);
      expect(conn1.closeReason).toBe("Server shutting down");
    });

    test("clears all internal maps (sessions empty after stop)", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-stop2",
        agentId: "agent-1",
        metadata: {},
      });
      const store = createInMemorySessionStore();
      gateway = createGateway({}, { transport, auth, store });
      await gateway.start(0);

      await authenticateConnection(transport, gateway, "s-stop2");
      expect(store.has("s-stop2")).toEqual({ ok: true, value: true });

      await gateway.stop();

      // The store is NOT cleared by stop() — stop only clears internal maps.
      // But send() should fail because connBySession is cleared.
      const result = gateway.send("s-stop2", createTestFrame());
      expect(result.ok).toBe(false);
    });

    test("stop is idempotent (calling twice does not throw)", async () => {
      const auth = createTestAuthenticator();
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      await gateway.stop();
      // Second stop should not throw
      await gateway.stop();
    });
  });

  // =========================================================================
  // Session lifecycle (destroySession, onSessionEvent)
  // =========================================================================

  describe("destroySession()", () => {
    test("force-destroys an active session", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-destroy",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const conn = await authenticateConnection(transport, gateway, "s-destroy");
      expect(conn.closed).toBe(false);

      const result = gateway.destroySession("s-destroy", "admin action");
      expect(result.ok).toBe(true);
      expect(conn.closed).toBe(true);
      expect(conn.closeCode).toBe(4012);
    });

    test("returns NOT_FOUND for non-existent session", async () => {
      const auth = createTestAuthenticator();
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const result = gateway.destroySession("no-such-session");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("emits 'destroyed' session event", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-destroy-event",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const events: unknown[] = [];
      gateway.onSessionEvent((e) => events.push(e));

      await authenticateConnection(transport, gateway, "s-destroy-event");
      gateway.destroySession("s-destroy-event", "test reason");

      const destroyed = events.find((e) => (e as { kind: string }).kind === "destroyed") as
        | { kind: "destroyed"; sessionId: string; reason: string }
        | undefined;
      expect(destroyed).toBeDefined();
      expect(destroyed?.sessionId).toBe("s-destroy-event");
      expect(destroyed?.reason).toBe("test reason");
    });

    test("destroys a disconnected session within TTL", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-disc-destroy",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({ sessionTtlMs: 30_000 }, { transport, auth });
      await gateway.start(0);

      const events: unknown[] = [];
      gateway.onSessionEvent((e) => events.push(e));

      const conn = await authenticateConnection(transport, gateway, "s-disc-destroy");
      transport.simulateClose(conn.id);

      const result = gateway.destroySession("s-disc-destroy");
      expect(result.ok).toBe(true);

      const destroyed = events.find((e) => (e as { kind: string }).kind === "destroyed");
      expect(destroyed).toBeDefined();
    });
  });

  describe("onSessionEvent()", () => {
    test("unsubscribe function prevents further events", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s-unsub",
        agentId: "agent-1",
        metadata: {},
      });
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const events: unknown[] = [];
      const unsub = gateway.onSessionEvent((e) => events.push(e));

      await authenticateConnection(transport, gateway, "s-unsub");
      expect(events.length).toBeGreaterThan(0);

      unsub();
      events.length = 0;
      gateway.destroySession("s-unsub");
      expect(events).toHaveLength(0);
    });
  });

  // =========================================================================
  // Node registry access
  // =========================================================================

  describe("nodeRegistry()", () => {
    test("returns the node registry instance", async () => {
      const auth = createTestAuthenticator();
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const reg = gateway.nodeRegistry();
      expect(reg).toBeDefined();
      expect(reg.size()).toBe(0);
    });

    test("node registry is usable for registration", async () => {
      const auth = createTestAuthenticator();
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const reg = gateway.nodeRegistry();
      const result = reg.register({
        nodeId: "node-1",
        mode: "full",
        tools: [{ name: "search" }],
        capacity: { current: 0, max: 10, available: 10 },
        connectedAt: Date.now(),
        lastHeartbeat: Date.now(),
        connId: "conn-1",
      });
      expect(result.ok).toBe(true);
      expect(reg.size()).toBe(1);
    });
  });

  describe("onNodeEvent()", () => {
    test("subscribe and unsubscribe work correctly", async () => {
      const auth = createTestAuthenticator();
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const events: unknown[] = [];
      const unsub = gateway.onNodeEvent((e) => events.push(e));

      // Events are not emitted by gateway itself yet (future node connection handling)
      // but the subscription mechanism should work
      expect(typeof unsub).toBe("function");
      unsub();
    });
  });
});
