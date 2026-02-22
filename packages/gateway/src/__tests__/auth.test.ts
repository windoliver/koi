import { afterEach, describe, expect, test } from "bun:test";
import type { GatewayAuthenticator, HandshakeOptions } from "../auth.js";
import { handleHandshake, startHeartbeatSweep } from "../auth.js";
import { createInMemorySessionStore } from "../session-store.js";
import type { ConnectFrame } from "../types.js";
import {
  createConnectMessage,
  createLegacyConnectMessage,
  createTestAuthenticator,
  createTestSession,
  waitForCondition,
} from "./test-utils.js";

// ---------------------------------------------------------------------------
// Default HandshakeOptions for tests
// ---------------------------------------------------------------------------

const DEFAULT_TEST_OPTIONS: HandshakeOptions = {
  minProtocolVersion: 1,
  maxProtocolVersion: 1,
  capabilities: { compression: false, resumption: false, maxFrameBytes: 1_048_576 },
};

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
    const promise = handleHandshake(conn, auth, 5000, DEFAULT_TEST_OPTIONS, (handler) => {
      messageHandler = handler;
    });

    // Simulate client sending structured connect frame
    messageHandler?.(createConnectMessage("my-secret-token"));

    const result = await promise;
    expect(result.session.id).toBe("session-1");
    expect(result.session.agentId).toBe("agent-1");
    expect(result.session.metadata).toEqual({ role: "admin" });
    expect(result.connectFrame.minProtocol).toBe(1);
    expect(result.connectFrame.maxProtocol).toBe(1);
    expect(result.connectFrame.auth.token).toBe("my-secret-token");
    // Should have sent an ack with protocol version and capabilities
    expect(conn.sent.length).toBe(1);
    const ack = JSON.parse(conn.sent[0] as string);
    expect(ack.kind).toBe("ack");
    expect(ack.payload.protocol).toBe(1);
    expect(ack.payload.capabilities).toEqual({
      compression: false,
      resumption: false,
      maxFrameBytes: 1_048_576,
    });
  });

  test("invalid token closes connection", async () => {
    const { conn } = createHandshakeConn();
    const auth = createTestAuthenticator({
      ok: false,
      code: "INVALID_TOKEN",
      message: "Bad token",
    });

    let messageHandler: ((data: string) => void) | undefined;
    const promise = handleHandshake(conn, auth, 5000, DEFAULT_TEST_OPTIONS, (handler) => {
      messageHandler = handler;
    });

    messageHandler?.(createConnectMessage("bad-token"));

    await expect(promise).rejects.toThrow("Auth failed: INVALID_TOKEN");
    expect(conn.closeCode).toBe(4003);
    // Should have sent error frame
    expect(conn.sent.length).toBe(1);
    const errFrame = JSON.parse(conn.sent[0] as string);
    expect(errFrame.kind).toBe("error");
  });

  test("malformed connect frame closes connection", async () => {
    const { conn } = createHandshakeConn();
    const auth = createTestAuthenticator();

    let messageHandler: ((data: string) => void) | undefined;
    const promise = handleHandshake(conn, auth, 5000, DEFAULT_TEST_OPTIONS, (handler) => {
      messageHandler = handler;
    });

    // Send raw string instead of connect frame
    messageHandler?.("just-a-raw-token");

    await expect(promise).rejects.toThrow("Invalid connect frame");
    expect(conn.closeCode).toBe(4002);
    expect(conn.sent.length).toBe(1);
    const errFrame = JSON.parse(conn.sent[0] as string);
    expect(errFrame.kind).toBe("error");
  });

  test("connect frame with client metadata is passed to authenticator", async () => {
    const { conn } = createHandshakeConn();

    let receivedFrame: ConnectFrame | undefined;
    const auth: GatewayAuthenticator = {
      async authenticate(frame: ConnectFrame) {
        receivedFrame = frame;
        return { ok: true, sessionId: "s1", agentId: "a1", metadata: {} };
      },
      async validate() {
        return true;
      },
    };

    let messageHandler: ((data: string) => void) | undefined;
    const promise = handleHandshake(conn, auth, 5000, DEFAULT_TEST_OPTIONS, (handler) => {
      messageHandler = handler;
    });

    messageHandler?.(
      createConnectMessage("tok", {
        client: { id: "cli-1", version: "2.0.0", platform: "web" },
      }),
    );

    await promise;
    expect(receivedFrame?.client?.id).toBe("cli-1");
    expect(receivedFrame?.client?.version).toBe("2.0.0");
    expect(receivedFrame?.client?.platform).toBe("web");
  });

  test("auth handshake timeout", async () => {
    const { conn } = createHandshakeConn();
    const auth = createTestAuthenticator();

    const promise = handleHandshake(conn, auth, 50, DEFAULT_TEST_OPTIONS, (_handler) => {
      // Never call the handler — simulates no token received
    });

    await expect(promise).rejects.toThrow("Auth handshake timed out");
    expect(conn.closeCode).toBe(4001);
  });

  test("authenticate() throwing rejects with auth service error", async () => {
    const { conn } = createHandshakeConn();
    const auth: GatewayAuthenticator = {
      async authenticate() {
        throw new Error("Auth service unavailable");
      },
      async validate() {
        return true;
      },
    };

    let messageHandler: ((data: string) => void) | undefined;
    const promise = handleHandshake(conn, auth, 5000, DEFAULT_TEST_OPTIONS, (handler) => {
      messageHandler = handler;
    });

    messageHandler?.(createConnectMessage("some-token"));

    await expect(promise).rejects.toThrow("Auth service error");
    expect(conn.closeCode).toBe(4003);
    // Should have sent error frame with INTERNAL code
    expect(conn.sent.length).toBe(1);
    const errFrame = JSON.parse(conn.sent[0] as string);
    expect(errFrame.kind).toBe("error");
    expect(errFrame.payload.code).toBe("INTERNAL");
  });

  // ----- Version negotiation tests -----

  test("version mismatch closes with 4010 and PROTOCOL_MISMATCH error", async () => {
    const { conn } = createHandshakeConn();
    const auth = createTestAuthenticator();

    const options: HandshakeOptions = {
      minProtocolVersion: 3,
      maxProtocolVersion: 5,
      capabilities: { compression: false, resumption: false, maxFrameBytes: 1_048_576 },
    };

    let messageHandler: ((data: string) => void) | undefined;
    const promise = handleHandshake(conn, auth, 5000, options, (handler) => {
      messageHandler = handler;
    });

    // Client only speaks protocol 1-2, server requires 3-5
    messageHandler?.(createConnectMessage("tok", { minProtocol: 1, maxProtocol: 2 }));

    await expect(promise).rejects.toThrow("Protocol mismatch");
    expect(conn.closeCode).toBe(4010);
    expect(conn.sent.length).toBe(1);
    const errFrame = JSON.parse(conn.sent[0] as string);
    expect(errFrame.kind).toBe("error");
    expect(errFrame.payload.code).toBe("PROTOCOL_MISMATCH");
  });

  test("negotiates highest overlap version", async () => {
    const { conn } = createHandshakeConn();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s1",
      agentId: "a1",
      metadata: {},
    });

    const options: HandshakeOptions = {
      minProtocolVersion: 1,
      maxProtocolVersion: 3,
      capabilities: { compression: false, resumption: false, maxFrameBytes: 1_048_576 },
    };

    let messageHandler: ((data: string) => void) | undefined;
    const promise = handleHandshake(conn, auth, 5000, options, (handler) => {
      messageHandler = handler;
    });

    // Client speaks 2-5, server speaks 1-3 → negotiated = 3
    messageHandler?.(createConnectMessage("tok", { minProtocol: 2, maxProtocol: 5 }));

    await promise;
    const ack = JSON.parse(conn.sent[0] as string);
    expect(ack.payload.protocol).toBe(3);
  });

  test("ack includes capabilities", async () => {
    const { conn } = createHandshakeConn();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s1",
      agentId: "a1",
      metadata: {},
    });

    const options: HandshakeOptions = {
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
      capabilities: { compression: true, resumption: true, maxFrameBytes: 2_097_152 },
    };

    let messageHandler: ((data: string) => void) | undefined;
    const promise = handleHandshake(conn, auth, 5000, options, (handler) => {
      messageHandler = handler;
    });

    messageHandler?.(createConnectMessage("tok"));
    await promise;

    const ack = JSON.parse(conn.sent[0] as string);
    expect(ack.payload.capabilities).toEqual({
      compression: true,
      resumption: true,
      maxFrameBytes: 2_097_152,
    });
  });

  test("ack includes snapshot when provided", async () => {
    const { conn } = createHandshakeConn();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s1",
      agentId: "a1",
      metadata: {},
    });

    const options: HandshakeOptions = {
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
      capabilities: { compression: false, resumption: false, maxFrameBytes: 1_048_576 },
      snapshot: { serverTime: 1700000000000, activeConnections: 42 },
    };

    let messageHandler: ((data: string) => void) | undefined;
    const promise = handleHandshake(conn, auth, 5000, options, (handler) => {
      messageHandler = handler;
    });

    messageHandler?.(createConnectMessage("tok"));
    await promise;

    const ack = JSON.parse(conn.sent[0] as string);
    expect(ack.payload.snapshot).toEqual({
      serverTime: 1700000000000,
      activeConnections: 42,
    });
  });

  test("ack omits snapshot when not provided", async () => {
    const { conn } = createHandshakeConn();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s1",
      agentId: "a1",
      metadata: {},
    });

    let messageHandler: ((data: string) => void) | undefined;
    const promise = handleHandshake(conn, auth, 5000, DEFAULT_TEST_OPTIONS, (handler) => {
      messageHandler = handler;
    });

    messageHandler?.(createConnectMessage("tok"));
    await promise;

    const ack = JSON.parse(conn.sent[0] as string);
    expect(ack.payload.snapshot).toBeUndefined();
  });

  test("backward compat: legacy protocol field works", async () => {
    const { conn } = createHandshakeConn();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s1",
      agentId: "a1",
      metadata: {},
    });

    let messageHandler: ((data: string) => void) | undefined;
    const promise = handleHandshake(conn, auth, 5000, DEFAULT_TEST_OPTIONS, (handler) => {
      messageHandler = handler;
    });

    // Send legacy format with single protocol field
    messageHandler?.(createLegacyConnectMessage("tok", 1));

    const result = await promise;
    expect(result.connectFrame.minProtocol).toBe(1);
    expect(result.connectFrame.maxProtocol).toBe(1);
    const ack = JSON.parse(conn.sent[0] as string);
    expect(ack.payload.protocol).toBe(1);
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

    // Use fast sweep interval to ensure all 10 shards are covered
    stopSweep = startHeartbeatSweep(store, auth, 30_000, 20, (id) => {
      expiredIds.push(id);
    });

    // Wait long enough for all shards to sweep (10 shards × 20ms = 200ms + margin)
    await waitForCondition(() => expiredIds.includes("s1"), 2000);

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

    stopSweep = startHeartbeatSweep(store, auth, 30_000, 20, (id) => {
      expiredIds.push(id);
    });

    // Wait for enough sweeps to cover all shards
    await waitForCondition(() => {
      const updated = store.get("s1");
      return updated !== undefined && updated.lastHeartbeat > activeSession.lastHeartbeat;
    }, 2000);

    expect(expiredIds).toHaveLength(0);
    expect(store.has("s1")).toBe(true);
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

    stopSweep = startHeartbeatSweep(store, auth, 30_000, 20, () => {});

    // Wait for all shards to sweep
    await new Promise((r) => setTimeout(r, 300));

    expect(validateCalled).toBe(false);
  });

  test("stop function clears the interval", async () => {
    const store = createInMemorySessionStore();
    const auth = createTestAuthenticator();

    let sweepCount = 0;

    stopSweep = startHeartbeatSweep(store, auth, 30_000, 50, () => {
      sweepCount++;
    });

    stopSweep();
    stopSweep = undefined;

    await new Promise((r) => setTimeout(r, 150));
    // No sweeps should have triggered expiry callbacks
    expect(sweepCount).toBe(0);
  });

  test("validate() throwing keeps session alive (fail-open)", async () => {
    const store = createInMemorySessionStore();
    const expiredSession = createTestSession({
      id: "s-fail-open",
      lastHeartbeat: Date.now() - 60_000, // 60s ago — will be checked
    });
    store.set(expiredSession);

    const expiredIds: string[] = [];
    const auth: GatewayAuthenticator = {
      authenticate: async () => ({
        ok: true,
        sessionId: "s-fail-open",
        agentId: "a",
        metadata: {},
      }),
      validate: async () => {
        throw new Error("Auth service down");
      },
    };

    stopSweep = startHeartbeatSweep(store, auth, 30_000, 20, (id) => {
      expiredIds.push(id);
    });

    // Wait for all shards to sweep
    await new Promise((r) => setTimeout(r, 300));

    // Session should still be in the store (fail-open: error → keep session)
    expect(store.has("s-fail-open")).toBe(true);
    expect(expiredIds).toHaveLength(0);
  });

  test("onError callback is invoked with context when validate() throws", async () => {
    const store = createInMemorySessionStore();
    store.set(
      createTestSession({
        id: "s-err-cb",
        lastHeartbeat: Date.now() - 60_000,
      }),
    );

    const errors: Array<{ sessionId: string; cause: unknown }> = [];
    const authError = new Error("Auth service unavailable");
    const auth: GatewayAuthenticator = {
      authenticate: async () => ({ ok: true, sessionId: "s-err-cb", agentId: "a", metadata: {} }),
      validate: async () => {
        throw authError;
      },
    };

    stopSweep = startHeartbeatSweep(
      store,
      auth,
      30_000,
      20,
      () => {},
      (err) => {
        errors.push(err);
      },
    );

    await waitForCondition(() => errors.length > 0, 2000);

    expect(errors[0]?.sessionId).toBe("s-err-cb");
    expect(errors[0]?.cause).toBe(authError);
    // Session still alive (fail-open)
    expect(store.has("s-err-cb")).toBe(true);
  });

  test("partial failure: valid sessions evicted, errored sessions kept", async () => {
    const store = createInMemorySessionStore();
    // Both sessions are stale (60s ago)
    store.set(createTestSession({ id: "s-invalid", lastHeartbeat: Date.now() - 60_000 }));
    store.set(createTestSession({ id: "s-errored", lastHeartbeat: Date.now() - 60_000 }));

    const expiredIds: string[] = [];
    const errors: Array<{ sessionId: string }> = [];
    const auth: GatewayAuthenticator = {
      authenticate: async () => ({ ok: true, sessionId: "x", agentId: "a", metadata: {} }),
      validate: async (sessionId: string) => {
        if (sessionId === "s-errored") throw new Error("Auth service partial failure");
        return false; // s-invalid fails validation
      },
    };

    stopSweep = startHeartbeatSweep(
      store,
      auth,
      30_000,
      20,
      (id) => {
        expiredIds.push(id);
      },
      (err) => {
        errors.push(err);
      },
    );

    // Wait for both sessions to be swept
    await waitForCondition(
      () => expiredIds.includes("s-invalid") && errors.some((e) => e.sessionId === "s-errored"),
      2000,
    );

    // s-invalid was evicted (validation returned false)
    expect(expiredIds).toContain("s-invalid");
    expect(store.has("s-invalid")).toBe(false);

    // s-errored kept alive (fail-open on auth error)
    expect(store.has("s-errored")).toBe(true);
    expect(errors.some((e) => e.sessionId === "s-errored")).toBe(true);
  });
});
