import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Gateway } from "../gateway.js";
import { createGateway } from "../gateway.js";
import type { GatewayFrame } from "../types.js";
import type { MockTransport } from "./test-utils.js";
import {
  createConnectMessage,
  createMockTransport,
  createTestAuthenticator,
} from "./test-utils.js";

describe("Gateway integration", () => {
  let transport: MockTransport;
  let gateway: Gateway;

  beforeEach(async () => {
    transport = createMockTransport();
  });

  afterEach(async () => {
    await gateway.stop();
  });

  test("connect → auth → send frame → receive ack", async () => {
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s1",
      agentId: "agent-1",
      metadata: {},
    });
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);

    const receivedFrames: GatewayFrame[] = [];
    gateway.onFrame((_session, frame) => {
      receivedFrames.push(frame);
    });

    // Client connects
    const conn = transport.simulateOpen();

    // Client sends auth token
    transport.simulateMessage(conn.id, createConnectMessage("valid-token"));
    // Wait for async auth
    await new Promise((r) => setTimeout(r, 50));

    // Client sends a frame
    const frame = JSON.stringify({
      kind: "request",
      id: "req-1",
      seq: 0,
      timestamp: Date.now(),
      payload: { action: "hello" },
    });
    transport.simulateMessage(conn.id, frame);

    // Wait for processing
    await new Promise((r) => setTimeout(r, 50));

    // Should have received the frame via onFrame
    expect(receivedFrames).toHaveLength(1);
    expect(receivedFrames[0]?.id).toBe("req-1");

    // Connection should have received ack (first for auth, second for frame)
    expect(conn.sent.length).toBeGreaterThanOrEqual(2);
    const lastMsg = JSON.parse(conn.sent[conn.sent.length - 1] as string);
    expect(lastMsg.kind).toBe("ack");
    expect(lastMsg.ref).toBe("req-1");
  });

  test("rejects connection when auth fails", async () => {
    const auth = createTestAuthenticator({
      ok: false,
      code: "INVALID_TOKEN",
      message: "Nope",
    });
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);

    const conn = transport.simulateOpen();
    transport.simulateMessage(conn.id, createConnectMessage("bad-token"));

    await new Promise((r) => setTimeout(r, 50));

    expect(conn.closed).toBe(true);
    expect(conn.closeCode).toBe(4003);
  });

  test("sends error for invalid frame after auth", async () => {
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s1",
      agentId: "agent-1",
      metadata: {},
    });
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);

    const conn = transport.simulateOpen();
    transport.simulateMessage(conn.id, createConnectMessage("valid-token"));
    await new Promise((r) => setTimeout(r, 50));

    // Send invalid frame
    transport.simulateMessage(conn.id, "{invalid json");
    await new Promise((r) => setTimeout(r, 50));

    // Should receive error frame
    const messages = conn.sent;
    const lastMsg = JSON.parse(messages[messages.length - 1] as string);
    expect(lastMsg.kind).toBe("error");
  });

  test("gateway.send delivers frame to connected session", async () => {
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s1",
      agentId: "agent-1",
      metadata: {},
    });
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);

    const conn = transport.simulateOpen();
    transport.simulateMessage(conn.id, createConnectMessage("valid-token"));
    await new Promise((r) => setTimeout(r, 50));

    const outFrame: GatewayFrame = {
      kind: "event",
      id: "evt-1",
      seq: 0,
      timestamp: Date.now(),
      payload: { data: "world" },
    };

    const result = gateway.send("s1", outFrame);
    expect(result.ok).toBe(true);

    // Connection should have received the encoded frame
    const lastMsg = JSON.parse(conn.sent[conn.sent.length - 1] as string);
    expect(lastMsg.kind).toBe("event");
    expect(lastMsg.id).toBe("evt-1");
  });

  test("gateway.send returns error for unknown session", () => {
    const auth = createTestAuthenticator();
    gateway = createGateway({}, { transport, auth });

    const result = gateway.send("nonexistent", {
      kind: "event",
      id: "x",
      seq: 0,
      timestamp: Date.now(),
      payload: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("deduplicates frames with same seq", async () => {
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s1",
      agentId: "agent-1",
      metadata: {},
    });
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);

    const receivedFrames: GatewayFrame[] = [];
    gateway.onFrame((_session, frame) => {
      receivedFrames.push(frame);
    });

    const conn = transport.simulateOpen();
    transport.simulateMessage(conn.id, createConnectMessage());
    await new Promise((r) => setTimeout(r, 50));

    const frame = JSON.stringify({
      kind: "request",
      id: "req-dup",
      seq: 0,
      timestamp: Date.now(),
      payload: null,
    });

    // Send same frame twice
    transport.simulateMessage(conn.id, frame);
    transport.simulateMessage(conn.id, frame);
    await new Promise((r) => setTimeout(r, 50));

    // Should only dispatch once
    expect(receivedFrames).toHaveLength(1);
  });

  test("onFrame unsubscribe stops receiving frames", async () => {
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s1",
      agentId: "agent-1",
      metadata: {},
    });
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);

    const receivedFrames: GatewayFrame[] = [];
    const unsub = gateway.onFrame((_session, frame) => {
      receivedFrames.push(frame);
    });

    const conn = transport.simulateOpen();
    transport.simulateMessage(conn.id, createConnectMessage());
    await new Promise((r) => setTimeout(r, 50));

    // Unsubscribe
    unsub();

    transport.simulateMessage(
      conn.id,
      JSON.stringify({
        kind: "request",
        id: "req-after-unsub",
        seq: 0,
        timestamp: Date.now(),
        payload: null,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedFrames).toHaveLength(0);
  });

  test("cleanup on connection close", async () => {
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s1",
      agentId: "agent-1",
      metadata: {},
    });
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);

    const conn = transport.simulateOpen();
    transport.simulateMessage(conn.id, createConnectMessage());
    await new Promise((r) => setTimeout(r, 50));

    expect(gateway.sessions().has("s1")).toBe(true);

    // Client disconnects
    transport.simulateClose(conn.id);

    // send should fail now
    const result = gateway.send("s1", {
      kind: "event",
      id: "x",
      seq: 0,
      timestamp: Date.now(),
      payload: null,
    });
    expect(result.ok).toBe(false);
  });
});
