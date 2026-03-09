import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Gateway } from "../gateway.js";
import { createGateway } from "../gateway.js";
import type { GatewayFrame } from "../types.js";
import type { MockTransport } from "./test-utils.js";
import {
  createConnectMessage,
  createMockTransport,
  createResumeConnectMessage,
  createTestAuthenticator,
  createTestFrame,
  resetTestSeqCounter,
  storeHas,
  waitForCondition,
} from "./test-utils.js";

describe("Session Resume", () => {
  let transport: MockTransport;
  let gw: Gateway;
  const SESSION_TTL = 5_000;
  const SESSION_ID = "resume-session-1";

  beforeEach(async () => {
    resetTestSeqCounter();
    transport = createMockTransport();
  });

  afterEach(async () => {
    await gw.stop();
  });

  function createResumeGateway(): Gateway {
    return createGateway(
      { sessionTtlMs: SESSION_TTL },
      {
        transport,
        auth: createTestAuthenticator({
          ok: true,
          sessionId: SESSION_ID,
          agentId: "test-agent",
          metadata: {},
        }),
      },
    );
  }

  async function connectClient(): Promise<string> {
    const conn = transport.simulateOpen();
    transport.simulateMessage(conn.id, createConnectMessage());
    await waitForCondition(() => storeHas(gw.sessions(), SESSION_ID));
    return conn.id;
  }

  test("keeps session alive during TTL after disconnect", async () => {
    gw = createResumeGateway();
    await gw.start(0);

    const connId = await connectClient();
    expect(storeHas(gw.sessions(), SESSION_ID)).toBe(true);

    // Disconnect
    transport.simulateClose(connId);

    // Session should still be in store during TTL
    expect(storeHas(gw.sessions(), SESSION_ID)).toBe(true);
  });

  test("emits 'created' event on new connection", async () => {
    gw = createResumeGateway();
    await gw.start(0);

    const events: unknown[] = [];
    gw.onSessionEvent((e) => events.push(e));

    await connectClient();
    await waitForCondition(() => events.length > 0);

    expect(events).toHaveLength(1);
    expect((events[0] as { kind: string }).kind).toBe("created");
  });

  test("resumes session within TTL window", async () => {
    gw = createResumeGateway();
    await gw.start(0);

    const events: unknown[] = [];
    gw.onSessionEvent((e) => events.push(e));

    const connId = await connectClient();
    // Clear events from creation
    events.length = 0;

    // Disconnect
    transport.simulateClose(connId);

    // Reconnect with resume
    const conn2 = transport.simulateOpen();
    transport.simulateMessage(conn2.id, createResumeConnectMessage(SESSION_ID, 0));

    await waitForCondition(() => events.length > 0);
    expect((events[0] as { kind: string }).kind).toBe("resumed");
    expect((events[0] as { pendingFrameCount: number }).pendingFrameCount).toBe(0);
  });

  test("rejects resume for expired session", async () => {
    gw = createGateway(
      { sessionTtlMs: 50 }, // very short TTL
      {
        transport,
        auth: createTestAuthenticator({
          ok: true,
          sessionId: SESSION_ID,
          agentId: "test-agent",
          metadata: {},
        }),
      },
    );
    await gw.start(0);

    const connId = await connectClient();
    transport.simulateClose(connId);

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 100));

    // Try to resume — should fail
    const conn2 = transport.simulateOpen();
    transport.simulateMessage(conn2.id, createResumeConnectMessage(SESSION_ID, 0));

    await waitForCondition(() => conn2.closed);
    expect(conn2.closeCode).toBe(4011);
    expect(conn2.closeReason).toBe("Session expired");
  });

  test("buffers frames sent to disconnected session and replays on resume", async () => {
    gw = createResumeGateway();
    await gw.start(0);

    const connId = await connectClient();

    // Disconnect
    transport.simulateClose(connId);

    // Send frames while disconnected — should buffer
    const frame1: GatewayFrame = createTestFrame({ seq: 0 });
    const frame2: GatewayFrame = createTestFrame({ seq: 1 });
    const result1 = gw.send(SESSION_ID, frame1);
    const result2 = gw.send(SESSION_ID, frame2);
    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);

    // Resume
    const conn2 = transport.simulateOpen();
    transport.simulateMessage(conn2.id, createResumeConnectMessage(SESSION_ID, 0));

    // Wait for resume to complete
    await waitForCondition(() => conn2.sent.length >= 2);

    // Verify replayed frames
    expect(conn2.sent.length).toBeGreaterThanOrEqual(2);
    // First 2 sent messages should be the buffered frames (after handshake ack)
    // Handshake ack is sent first by handleHandshake, then our replayed frames
    const sentPayloads = conn2.sent.map((s) => {
      try {
        return JSON.parse(s) as { id: string };
      } catch {
        return null;
      }
    });
    const replayedIds = sentPayloads
      .filter((p): p is { id: string } => p !== null)
      .map((p) => p.id);
    expect(replayedIds).toContain(frame1.id);
    expect(replayedIds).toContain(frame2.id);
  });

  test("emits 'expired' event when TTL timer fires", async () => {
    gw = createGateway(
      { sessionTtlMs: 50 },
      {
        transport,
        auth: createTestAuthenticator({
          ok: true,
          sessionId: SESSION_ID,
          agentId: "test-agent",
          metadata: {},
        }),
      },
    );
    await gw.start(0);

    const events: unknown[] = [];
    gw.onSessionEvent((e) => events.push(e));

    const connId = await connectClient();
    events.length = 0; // clear 'created' event

    transport.simulateClose(connId);

    // Wait for TTL expiry
    await waitForCondition(
      () => events.some((e) => (e as { kind: string }).kind === "expired"),
      2000,
    );

    const expired = events.find((e) => (e as { kind: string }).kind === "expired") as
      | { kind: "expired"; sessionId: string }
      | undefined;
    expect(expired).toBeDefined();
    expect(expired?.sessionId).toBe(SESSION_ID);
  });

  test("immediate cleanup when sessionTtlMs is 0", async () => {
    gw = createGateway(
      { sessionTtlMs: 0 },
      {
        transport,
        auth: createTestAuthenticator({
          ok: true,
          sessionId: SESSION_ID,
          agentId: "test-agent",
          metadata: {},
        }),
      },
    );
    await gw.start(0);

    const connId = await connectClient();
    transport.simulateClose(connId);

    // Session should be deleted immediately
    await waitForCondition(() => !storeHas(gw.sessions(), SESSION_ID));
    expect(storeHas(gw.sessions(), SESSION_ID)).toBe(false);
  });

  test("advertises resumption capability when TTL > 0", async () => {
    gw = createResumeGateway();
    await gw.start(0);

    const conn = transport.simulateOpen();
    transport.simulateMessage(conn.id, createConnectMessage());
    await waitForCondition(() => conn.sent.length > 0);

    // Parse the handshake ack
    const ackStr = conn.sent[0];
    expect(ackStr).toBeDefined();
    const ack = JSON.parse(ackStr ?? "") as { payload: { capabilities: { resumption: boolean } } };
    expect(ack.payload.capabilities.resumption).toBe(true);
  });

  test("rejects resume for unknown session ID", async () => {
    gw = createResumeGateway();
    await gw.start(0);

    const conn = transport.simulateOpen();
    transport.simulateMessage(conn.id, createResumeConnectMessage("non-existent-session", 0));

    await waitForCondition(() => conn.closed);
    expect(conn.closeCode).toBe(4011);
  });

  test("rejects resume when auth fails", async () => {
    // First: connect with a successful auth
    gw = createResumeGateway();
    await gw.start(0);

    const connId = await connectClient();
    transport.simulateClose(connId);

    // Stop the gateway and create a new one with failing auth
    await gw.stop();

    transport = createMockTransport();
    gw = createGateway(
      { sessionTtlMs: SESSION_TTL },
      {
        transport,
        auth: createTestAuthenticator({
          ok: false,
          code: "INVALID_TOKEN",
          message: "Bad credentials",
        }),
      },
    );
    await gw.start(0);

    // Try to resume — auth should reject before resume path is reached
    const conn = transport.simulateOpen();
    transport.simulateMessage(conn.id, createResumeConnectMessage(SESSION_ID, 0));

    await waitForCondition(() => conn.closed);
    expect(conn.closeCode).toBe(4003);
  });

  test("preserves tracker state after resume (regression)", async () => {
    gw = createResumeGateway();
    await gw.start(0);

    const dispatched: GatewayFrame[] = [];
    gw.onFrame((_session, frame) => {
      dispatched.push(frame);
    });

    const connId = await connectClient();

    // Send seq 0 and 1 before disconnect
    transport.simulateMessage(
      connId,
      JSON.stringify({ kind: "request", id: "r0", seq: 0, timestamp: Date.now(), payload: null }),
    );
    transport.simulateMessage(
      connId,
      JSON.stringify({ kind: "request", id: "r1", seq: 1, timestamp: Date.now(), payload: null }),
    );
    await waitForCondition(() => dispatched.length >= 2);

    // Disconnect
    transport.simulateClose(connId);

    // Resume
    const conn2 = transport.simulateOpen();
    transport.simulateMessage(conn2.id, createResumeConnectMessage(SESSION_ID, 0));
    await waitForCondition(() => conn2.sent.length > 0);

    // Send seq 2 — should be accepted (tracker remembers nextExpected = 2)
    transport.simulateMessage(
      conn2.id,
      JSON.stringify({ kind: "request", id: "r2", seq: 2, timestamp: Date.now(), payload: null }),
    );
    await waitForCondition(() => dispatched.length >= 3);

    expect(dispatched).toHaveLength(3);
    expect(dispatched[2]?.id).toBe("r2");
  });

  test("concurrent resume attempts: second attempt fails", async () => {
    gw = createResumeGateway();
    await gw.start(0);

    const connId = await connectClient();
    transport.simulateClose(connId);

    // First resume — should succeed
    const conn2 = transport.simulateOpen();
    transport.simulateMessage(conn2.id, createResumeConnectMessage(SESSION_ID, 0));
    await waitForCondition(() => conn2.sent.length > 0);

    // Second concurrent resume — session is no longer in disconnected map
    const conn3 = transport.simulateOpen();
    transport.simulateMessage(conn3.id, createResumeConnectMessage(SESSION_ID, 0));

    await waitForCondition(() => conn3.closed);
    expect(conn3.closeCode).toBe(4011);
  });

  test("resume with lastSeq filters already-seen buffered frames (regression)", async () => {
    gw = createResumeGateway();
    await gw.start(0);

    const connId = await connectClient();

    // Disconnect
    transport.simulateClose(connId);

    // Buffer 3 frames while disconnected (seq 0, 1, 2)
    const frame0: GatewayFrame = createTestFrame({ seq: 0 });
    const frame1: GatewayFrame = createTestFrame({ seq: 1 });
    const frame2: GatewayFrame = createTestFrame({ seq: 2 });
    gw.send(SESSION_ID, frame0);
    gw.send(SESSION_ID, frame1);
    gw.send(SESSION_ID, frame2);

    // Resume with lastSeq=2 (client already saw seq 0, 1, and started at 2)
    const conn2 = transport.simulateOpen();
    transport.simulateMessage(conn2.id, createResumeConnectMessage(SESSION_ID, 2));

    // Small delay to ensure all frames are sent
    await new Promise((r) => setTimeout(r, 50));

    // Only frame with seq >= 2 (i.e., seq 2) should be replayed
    const sentPayloads = conn2.sent
      .map((s) => {
        try {
          return JSON.parse(s) as { id: string; seq?: number };
        } catch {
          return null;
        }
      })
      .filter((p): p is { id: string; seq?: number } => p !== null);

    const replayedIds = sentPayloads.map((p) => p.id);
    expect(replayedIds).not.toContain(frame0.id);
    expect(replayedIds).not.toContain(frame1.id);
    expect(replayedIds).toContain(frame2.id);
  });

  test("returns error when pending frame buffer is full", async () => {
    gw = createResumeGateway();
    await gw.start(0);

    const connId = await connectClient();
    transport.simulateClose(connId);

    // Fill buffer up to the limit (1000)
    for (let i = 0; i < 1_000; i++) {
      const result = gw.send(SESSION_ID, createTestFrame({ seq: i }));
      expect(result.ok).toBe(true);
    }

    // Next frame should be rejected
    const overflow = gw.send(SESSION_ID, createTestFrame({ seq: 1_000 }));
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.error.code).toBe("VALIDATION");
      expect(overflow.error.message).toContain("Pending frame limit");
    }
  });
});
