import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleHandshake } from "../auth.js";
import { CLOSE_CODES } from "../close-codes.js";
import {
  createConnectMessage,
  createLegacyConnectMessage,
  createMockTransport,
  createTestAuthenticator,
  type MockConnection,
  type MockTransport,
} from "./test-utils.js";

const defaultOptions = {
  minProtocolVersion: 1,
  maxProtocolVersion: 1,
  capabilities: { compression: false, maxFrameBytes: 1_048_576 },
};

async function expectRejects(promise: Promise<unknown>, msgFragment: string): Promise<void> {
  try {
    await promise;
    throw new Error("Expected promise to reject but it resolved");
  } catch (e: unknown) {
    if (e instanceof Error && e.message === "Expected promise to reject but it resolved") throw e;
    if (msgFragment && e instanceof Error) expect(e.message).toContain(msgFragment);
  }
}

describe("handleHandshake", () => {
  let transport: MockTransport;
  let conn: MockConnection;

  beforeEach(() => {
    transport = createMockTransport();
  });

  afterEach(() => {
    transport.close();
  });

  test("resolves with session on successful auth", async () => {
    conn = transport.simulateOpen();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "sess-1",
      agentId: "agent-1",
      metadata: { user: "alice" },
    });

    let firstMessageHandler: ((data: string) => void) | undefined;
    const handshakePromise = handleHandshake(conn, auth, 1000, defaultOptions, (h) => {
      firstMessageHandler = h;
    });

    firstMessageHandler?.(createConnectMessage("token"));
    const result = await handshakePromise;

    expect(result.session.id).toBe("sess-1");
    expect(result.session.agentId).toBe("agent-1");
    expect(result.session.seq).toBe(0);
    expect(result.session.remoteSeq).toBe(0);
    // ack not yet sent — caller must invoke sendAck() after persistence
    expect(conn.sent.length).toBe(0);
    result.sendAck();
    expect(conn.sent.length).toBeGreaterThan(0);
    const rawAck = conn.sent[0] ?? "";
    const ack = JSON.parse(rawAck) as Record<string, unknown>;
    expect(ack.kind).toBe("ack");
  });

  test("rejects and closes on invalid connect frame", async () => {
    conn = transport.simulateOpen();
    let firstMessageHandler: ((data: string) => void) | undefined;
    const handshakePromise = handleHandshake(
      conn,
      createTestAuthenticator(),
      1000,
      defaultOptions,
      (h) => {
        firstMessageHandler = h;
      },
    );

    firstMessageHandler?.(JSON.stringify({ kind: "not-connect", auth: { token: "t" } }));
    await expectRejects(handshakePromise, "Invalid connect frame");
    expect(conn.closed).toBe(true);
    expect(conn.closeCode).toBe(CLOSE_CODES.INVALID_HANDSHAKE);
  });

  test("rejects and closes on auth failure", async () => {
    conn = transport.simulateOpen();
    const auth = createTestAuthenticator({
      ok: false,
      code: "INVALID_TOKEN",
      message: "bad token",
    });
    let firstMessageHandler: ((data: string) => void) | undefined;
    const handshakePromise = handleHandshake(conn, auth, 1000, defaultOptions, (h) => {
      firstMessageHandler = h;
    });

    firstMessageHandler?.(createConnectMessage("bad-token"));
    await expectRejects(handshakePromise, "Auth failed");
    expect(conn.closed).toBe(true);
    expect(conn.closeCode).toBe(CLOSE_CODES.AUTH_FAILED);
  });

  test("rejects on protocol mismatch", async () => {
    conn = transport.simulateOpen();
    let firstMessageHandler: ((data: string) => void) | undefined;
    const handshakePromise = handleHandshake(
      conn,
      createTestAuthenticator(),
      1000,
      defaultOptions,
      (h) => {
        firstMessageHandler = h;
      },
    );

    // Client requests protocol 2 but server only supports 1
    firstMessageHandler?.(
      JSON.stringify({ kind: "connect", minProtocol: 2, maxProtocol: 2, auth: { token: "t" } }),
    );
    await expectRejects(handshakePromise, "Protocol mismatch");
    expect(conn.closeCode).toBe(CLOSE_CODES.PROTOCOL_MISMATCH);
  });

  test("times out if no message received", async () => {
    conn = transport.simulateOpen();
    const handshakePromise = handleHandshake(
      conn,
      createTestAuthenticator(),
      20,
      defaultOptions,
      (_h) => {
        // intentionally never call _h — simulates no message from client
      },
    );

    await expectRejects(handshakePromise, "timed out");
    expect(conn.closeCode).toBe(CLOSE_CODES.AUTH_TIMEOUT);
  });

  test("accepts legacy single-protocol connect frame", async () => {
    conn = transport.simulateOpen();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s2",
      agentId: "a2",
      metadata: {},
    });
    let firstMessageHandler: ((data: string) => void) | undefined;
    const handshakePromise = handleHandshake(conn, auth, 1000, defaultOptions, (h) => {
      firstMessageHandler = h;
    });

    firstMessageHandler?.(createLegacyConnectMessage("tok"));
    const result = await handshakePromise;
    expect(result.session.id).toBe("s2");
  });

  test("includes snapshot in ack when provided", async () => {
    conn = transport.simulateOpen();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s3",
      agentId: "a3",
      metadata: {},
    });
    let firstMessageHandler: ((data: string) => void) | undefined;
    const opts = {
      ...defaultOptions,
      snapshot: { serverTime: 12345, activeConnections: 7 },
    };
    const handshakePromise = handleHandshake(conn, auth, 1000, opts, (h) => {
      firstMessageHandler = h;
    });

    firstMessageHandler?.(createConnectMessage());
    const snapshotResult = await handshakePromise;
    snapshotResult.sendAck();
    const rawSnapshotAck = conn.sent[0] ?? "";
    const ack = JSON.parse(rawSnapshotAck) as Record<string, unknown>;
    const payload = ack.payload as Record<string, unknown>;
    expect((payload.snapshot as Record<string, unknown>).serverTime).toBe(12345);
  });

  test("propagates routing context from auth result to session", async () => {
    conn = transport.simulateOpen();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s4",
      agentId: "a4",
      metadata: {},
      routing: { channel: "ch1", peer: "u1" },
    });
    let firstMessageHandler: ((data: string) => void) | undefined;
    const handshakePromise = handleHandshake(conn, auth, 1000, defaultOptions, (h) => {
      firstMessageHandler = h;
    });

    firstMessageHandler?.(createConnectMessage());
    const result = await handshakePromise;
    expect(result.session.routing?.channel).toBe("ch1");
    expect(result.session.routing?.peer).toBe("u1");
  });

  test("closes with INVALID_HANDSHAKE if frame arrives before ack", async () => {
    conn = transport.simulateOpen();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s5",
      agentId: "a5",
      metadata: {},
    });
    let firstMessageHandler: ((data: string) => void) | undefined;
    const handshakePromise = handleHandshake(conn, auth, 1000, defaultOptions, (h) => {
      firstMessageHandler = h;
    });

    firstMessageHandler?.(createConnectMessage("tok"));
    // Send a second message before the handshake promise resolves
    firstMessageHandler?.(JSON.stringify({ kind: "data", seq: 0, id: "f1", payload: {} }));

    await expectRejects(handshakePromise, "before handshake complete");
    expect(conn.closed).toBe(true);
    expect(conn.closeCode).toBe(CLOSE_CODES.INVALID_HANDSHAKE);
  });
});
