import { afterEach, describe, expect, test } from "bun:test";
import type { GatewayAuthenticator } from "../auth.js";
import { handleHandshake, startHeartbeatSweep } from "../auth.js";
import { createInMemorySessionStore } from "../session-store.js";
import { createTestAuthenticator, createTestSession } from "./test-utils.js";

// ---------------------------------------------------------------------------
// Mock connection for handshake tests
// ---------------------------------------------------------------------------

function createHandshakeConn(): {
  readonly conn: {
    readonly id: string;
    readonly remoteAddress: string;
    readonly send: (data: string) => number;
    readonly close: (code?: number, reason?: string) => void;
    readonly sent: string[];
    readonly closeCode: number | undefined;
    readonly closeReason: string | undefined;
  };
} {
  const sent: string[] = [];
  let closeCode: number | undefined;
  let closeReason: string | undefined;

  return {
    conn: {
      id: crypto.randomUUID(),
      remoteAddress: "127.0.0.1",
      send(data: string) {
        sent.push(data);
        return data.length;
      },
      close(code?: number, reason?: string) {
        closeCode = code;
        closeReason = reason;
      },
      get sent() {
        return sent;
      },
      get closeCode() {
        return closeCode;
      },
      get closeReason() {
        return closeReason;
      },
    },
  };
}

describe("handleHandshake", () => {
  test("successful handshake creates session", async () => {
    const { conn } = createHandshakeConn();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "session-1",
      agentId: "agent-1",
      metadata: { role: "admin" },
    });

    let messageHandler: ((data: string) => void) | undefined;
    const promise = handleHandshake(conn, auth, 5000, (handler) => {
      messageHandler = handler;
    });

    // Simulate client sending auth token
    messageHandler?.("my-secret-token");

    const result = await promise;
    expect(result.session.id).toBe("session-1");
    expect(result.session.agentId).toBe("agent-1");
    expect(result.session.metadata).toEqual({ role: "admin" });
    // Should have sent an ack
    expect(conn.sent.length).toBe(1);
    const ack = JSON.parse(conn.sent[0] as string);
    expect(ack.kind).toBe("ack");
  });

  test("invalid token closes connection", async () => {
    const { conn } = createHandshakeConn();
    const auth = createTestAuthenticator({
      ok: false,
      code: "INVALID_TOKEN",
      message: "Bad token",
    });

    let messageHandler: ((data: string) => void) | undefined;
    const promise = handleHandshake(conn, auth, 5000, (handler) => {
      messageHandler = handler;
    });

    messageHandler?.("bad-token");

    await expect(promise).rejects.toThrow("Auth failed: INVALID_TOKEN");
    expect(conn.closeCode).toBe(4003);
    // Should have sent error frame
    expect(conn.sent.length).toBe(1);
    const errFrame = JSON.parse(conn.sent[0] as string);
    expect(errFrame.kind).toBe("error");
  });

  test("auth handshake timeout", async () => {
    const { conn } = createHandshakeConn();
    const auth = createTestAuthenticator();

    const promise = handleHandshake(conn, auth, 50, (_handler) => {
      // Never call the handler — simulates no token received
    });

    await expect(promise).rejects.toThrow("Auth handshake timed out");
    expect(conn.closeCode).toBe(4001);
  });
});

describe("startHeartbeatSweep", () => {
  let stopSweep: (() => void) | undefined;

  afterEach(() => {
    stopSweep?.();
  });

  test("removes expired session when validation fails", async () => {
    const store = createInMemorySessionStore();
    const expiredSession = createTestSession({
      id: "s1",
      lastHeartbeat: Date.now() - 60_000, // 60s ago
    });
    store.set(expiredSession);

    const expiredIds: string[] = [];
    const auth: GatewayAuthenticator = {
      authenticate: async () => ({ ok: true, sessionId: "s1", agentId: "a", metadata: {} }),
      validate: async () => false, // always fail validation
    };

    stopSweep = startHeartbeatSweep(store, auth, 30_000, 50, (id) => {
      expiredIds.push(id);
    });

    // Wait for sweep to run
    await new Promise((r) => setTimeout(r, 150));

    expect(expiredIds).toContain("s1");
    expect(store.has("s1")).toBe(false);
  });

  test("keeps valid session alive", async () => {
    const store = createInMemorySessionStore();
    const activeSession = createTestSession({
      id: "s1",
      lastHeartbeat: Date.now() - 60_000,
    });
    store.set(activeSession);

    const expiredIds: string[] = [];
    const auth: GatewayAuthenticator = {
      authenticate: async () => ({ ok: true, sessionId: "s1", agentId: "a", metadata: {} }),
      validate: async () => true, // always pass
    };

    stopSweep = startHeartbeatSweep(store, auth, 30_000, 50, (id) => {
      expiredIds.push(id);
    });

    await new Promise((r) => setTimeout(r, 150));

    expect(expiredIds).toHaveLength(0);
    expect(store.has("s1")).toBe(true);
    // Heartbeat should have been updated
    const updated = store.get("s1");
    expect(updated?.lastHeartbeat).toBeGreaterThan(activeSession.lastHeartbeat);
  });

  test("skips sessions within heartbeat interval", async () => {
    const store = createInMemorySessionStore();
    store.set(
      createTestSession({
        id: "s1",
        lastHeartbeat: Date.now(), // just now
      }),
    );

    let validateCalled = false;
    const auth: GatewayAuthenticator = {
      authenticate: async () => ({ ok: true, sessionId: "s1", agentId: "a", metadata: {} }),
      validate: async () => {
        validateCalled = true;
        return true;
      },
    };

    stopSweep = startHeartbeatSweep(store, auth, 30_000, 50, () => {});

    await new Promise((r) => setTimeout(r, 150));

    expect(validateCalled).toBe(false);
  });

  test("stop function clears the interval", async () => {
    const store = createInMemorySessionStore();
    const auth = createTestAuthenticator();

    let sweepCount = 0;
    const _originalSet = store.set.bind(store);

    stopSweep = startHeartbeatSweep(store, auth, 30_000, 50, () => {
      sweepCount++;
    });

    stopSweep();
    stopSweep = undefined;

    await new Promise((r) => setTimeout(r, 150));
    // No sweeps should have triggered expiry callbacks
    expect(sweepCount).toBe(0);
  });
});
