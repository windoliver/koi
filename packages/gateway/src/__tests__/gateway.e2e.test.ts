/**
 * E2E tests: real Bun.serve WebSocket server + real WebSocket clients.
 * Tests the full wire path: TCP connect → WS upgrade → auth → frames → acks.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Gateway } from "../gateway.js";
import { createGateway } from "../gateway.js";
import type { BunTransport } from "../transport.js";
import { createBunTransport } from "../transport.js";
import type { ConnectFrame, GatewayFrame, Session } from "../types.js";
import { createConnectMessage, createLegacyConnectMessage, createTestAuthenticator } from "./test-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open a real WebSocket to the gateway and collect messages. */
function connectClient(port: number): Promise<{
  ws: WebSocket;
  messages: string[];
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
}> {
  const messages: string[] = [];

  let resolveOpened: () => void;
  const opened = new Promise<void>((r) => {
    resolveOpened = r;
  });

  let resolveClosed: (v: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((r) => {
    resolveClosed = r;
  });

  const ws = new WebSocket(`ws://localhost:${port}`);
  ws.addEventListener("open", () => resolveOpened());
  ws.addEventListener("message", (e) => messages.push(String(e.data)));
  ws.addEventListener("close", (e) => resolveClosed({ code: e.code, reason: e.reason }));

  return Promise.resolve({ ws, messages, opened, closed });
}

/** Wait until the messages array has at least `count` entries (with timeout). */
async function waitForMessages(
  messages: readonly string[],
  count: number,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (messages.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${count} messages (got ${messages.length})`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Gateway e2e (real WebSocket)", () => {
  let transport: BunTransport;
  let gateway: Gateway;

  afterEach(async () => {
    await gateway.stop();
  });

  test("full lifecycle: connect → auth → send → ack → server push → disconnect", async () => {
    transport = createBunTransport();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "e2e-session",
      agentId: "e2e-agent",
      metadata: {},
    });
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);

    const port = transport.port();
    const { ws, messages, opened } = await connectClient(port);
    await opened;

    // 1. Send structured connect frame
    ws.send(createConnectMessage("my-e2e-token"));
    await waitForMessages(messages, 1); // auth ack

    const authAck = JSON.parse(messages[0] as string);
    expect(authAck.kind).toBe("ack");
    expect(authAck.payload.sessionId).toBe("e2e-session");
    expect(authAck.payload.protocol).toBe(1);
    expect(authAck.payload.capabilities).toEqual({
      compression: false,
      resumption: false,
      maxFrameBytes: 1_048_576,
    });
    expect(authAck.payload.snapshot).toBeDefined();
    expect(typeof authAck.payload.snapshot.serverTime).toBe("number");
    expect(typeof authAck.payload.snapshot.activeConnections).toBe("number");

    // 2. Send a request frame
    const requestFrame = JSON.stringify({
      kind: "request",
      id: "req-e2e-1",
      seq: 0,
      timestamp: Date.now(),
      payload: { question: "hello" },
    });
    ws.send(requestFrame);
    await waitForMessages(messages, 2); // request ack

    const reqAck = JSON.parse(messages[1] as string);
    expect(reqAck.kind).toBe("ack");
    expect(reqAck.ref).toBe("req-e2e-1");

    // 3. Server pushes an event to the client
    const pushResult = gateway.send("e2e-session", {
      kind: "event",
      id: "srv-evt-1",
      seq: 0,
      timestamp: Date.now(),
      payload: { answer: "world" },
    });
    expect(pushResult.ok).toBe(true);
    await waitForMessages(messages, 3); // server event

    const srvEvt = JSON.parse(messages[2] as string);
    expect(srvEvt.kind).toBe("event");
    expect(srvEvt.id).toBe("srv-evt-1");
    expect(srvEvt.payload.answer).toBe("world");

    // 4. Clean disconnect
    ws.close();
  });

  test("auth rejection closes WebSocket with error frame", async () => {
    transport = createBunTransport();
    const auth = createTestAuthenticator({
      ok: false,
      code: "INVALID_TOKEN",
      message: "Bad credentials",
    });
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);

    const { ws, messages, opened, closed } = await connectClient(transport.port());
    await opened;

    ws.send(createConnectMessage("bad-token"));

    // Should receive error frame then close
    await waitForMessages(messages, 1);
    const errFrame = JSON.parse(messages[0] as string);
    expect(errFrame.kind).toBe("error");
    expect(errFrame.payload.code).toBe("INVALID_TOKEN");

    const closeEvt = await closed;
    expect(closeEvt.code).toBe(4003);
  });

  test("invalid frame after auth returns error frame", async () => {
    transport = createBunTransport();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s-invalid",
      agentId: "a",
      metadata: {},
    });
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);

    const { ws, messages, opened } = await connectClient(transport.port());
    await opened;

    ws.send(createConnectMessage());
    await waitForMessages(messages, 1); // auth ack

    // Send garbage
    ws.send("{not valid json!!!");
    await waitForMessages(messages, 2);

    const errFrame = JSON.parse(messages[1] as string);
    expect(errFrame.kind).toBe("error");

    ws.close();
  });

  test("deduplication over real WebSocket", async () => {
    transport = createBunTransport();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s-dedup",
      agentId: "a",
      metadata: {},
    });
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);

    const dispatched: GatewayFrame[] = [];
    gateway.onFrame((_session, frame) => {
      dispatched.push(frame);
    });

    const { ws, messages, opened } = await connectClient(transport.port());
    await opened;

    ws.send(createConnectMessage());
    await waitForMessages(messages, 1); // auth ack

    const frame = JSON.stringify({
      kind: "request",
      id: "dup-id",
      seq: 0,
      timestamp: Date.now(),
      payload: null,
    });

    // Send same frame twice rapidly
    ws.send(frame);
    ws.send(frame);
    await waitForMessages(messages, 3); // 2 acks (original + dup ack)
    // Wait a bit more to make sure no extra dispatch happens
    await new Promise((r) => setTimeout(r, 100));

    // Only dispatched once
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.id).toBe("dup-id");

    ws.close();
  });

  test("out-of-order frames are reordered", async () => {
    transport = createBunTransport();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s-order",
      agentId: "a",
      metadata: {},
    });
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);

    const dispatched: GatewayFrame[] = [];
    gateway.onFrame((_session, frame) => {
      dispatched.push(frame);
    });

    const { ws, messages, opened } = await connectClient(transport.port());
    await opened;

    ws.send(createConnectMessage());
    await waitForMessages(messages, 1);

    // Send seq 1 before seq 0
    ws.send(
      JSON.stringify({ kind: "request", id: "b", seq: 1, timestamp: Date.now(), payload: null }),
    );
    // Small delay to ensure ordering
    await new Promise((r) => setTimeout(r, 50));

    // seq 1 should be buffered, not dispatched
    expect(dispatched).toHaveLength(0);

    // Now send seq 0 — should flush both in order
    ws.send(
      JSON.stringify({ kind: "request", id: "a", seq: 0, timestamp: Date.now(), payload: null }),
    );
    await waitForMessages(messages, 3); // ack for seq 1 buffered + acks for seq 0 and seq 1
    await new Promise((r) => setTimeout(r, 100));

    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]?.id).toBe("a"); // seq 0 first
    expect(dispatched[1]?.id).toBe("b"); // seq 1 second

    ws.close();
  });

  test("multiple concurrent clients", async () => {
    transport = createBunTransport();

    let sessionCounter = 0;
    const auth = {
      async authenticate(_frame: ConnectFrame) {
        sessionCounter++;
        return {
          ok: true as const,
          sessionId: `session-${sessionCounter}`,
          agentId: "agent",
          metadata: {},
        };
      },
      async validate() {
        return true;
      },
    };

    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);
    const port = transport.port();

    // Connect 3 clients simultaneously
    const clients = await Promise.all([
      connectClient(port),
      connectClient(port),
      connectClient(port),
    ]);

    for (const client of clients) {
      await client.opened;
      client.ws.send(createConnectMessage());
    }

    // Wait for all auth acks
    for (const client of clients) {
      await waitForMessages(client.messages, 1);
      const ack = JSON.parse(client.messages[0] as string);
      expect(ack.kind).toBe("ack");
    }

    expect(gateway.sessions().size()).toBe(3);

    // Each client sends a frame
    for (const [i, client] of clients.entries()) {
      client.ws.send(
        JSON.stringify({
          kind: "request",
          id: `multi-${i}`,
          seq: 0,
          timestamp: Date.now(),
          payload: null,
        }),
      );
    }

    for (const client of clients) {
      await waitForMessages(client.messages, 2);
      client.ws.close();
    }
  });

  test("out-of-window seq returns error frame", async () => {
    transport = createBunTransport();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s-window",
      agentId: "a",
      metadata: {},
    });
    // Small dedup window of 4
    gateway = createGateway({ dedupWindowSize: 4 }, { transport, auth });
    await gateway.start(0);

    const { ws, messages, opened } = await connectClient(transport.port());
    await opened;

    ws.send(createConnectMessage());
    await waitForMessages(messages, 1); // auth ack

    // Send seq 10 — far beyond window [0..3]
    ws.send(
      JSON.stringify({
        kind: "request",
        id: "far-seq",
        seq: 10,
        timestamp: Date.now(),
        payload: null,
      }),
    );
    await waitForMessages(messages, 2);

    const errFrame = JSON.parse(messages[1] as string);
    expect(errFrame.kind).toBe("error");
    expect(errFrame.payload.message).toContain("out of window");

    ws.close();
  });

  test("heartbeat sweep closes session when validation fails", async () => {
    transport = createBunTransport();

    let shouldValidate = true;
    const auth = {
      async authenticate(_frame: ConnectFrame) {
        return {
          ok: true as const,
          sessionId: "s-heartbeat",
          agentId: "a",
          metadata: {},
        };
      },
      async validate(_sessionId: string) {
        return shouldValidate;
      },
    };

    // Short heartbeat and sweep intervals for fast test
    gateway = createGateway({ heartbeatIntervalMs: 50, sweepIntervalMs: 50 }, { transport, auth });
    await gateway.start(0);

    const { ws, messages, opened, closed } = await connectClient(transport.port());
    await opened;

    ws.send(createConnectMessage());
    await waitForMessages(messages, 1); // auth ack

    // Session is established
    expect(gateway.sessions().has("s-heartbeat")).toBe(true);

    // Revoke the session — next sweep should close it
    shouldValidate = false;

    // Wait for sweep to run and close the connection
    const closeEvt = await closed;
    expect(closeEvt.code).toBe(4004);
    expect(gateway.sessions().has("s-heartbeat")).toBe(false);
  });

  test("reconnection: new client resumes after disconnect", async () => {
    transport = createBunTransport();

    let sessionCounter = 0;
    const auth = {
      async authenticate(_frame: ConnectFrame) {
        sessionCounter++;
        return {
          ok: true as const,
          sessionId: `reconnect-${sessionCounter}`,
          agentId: "a",
          metadata: {},
        };
      },
      async validate() {
        return true;
      },
    };

    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);
    const port = transport.port();

    const dispatched: GatewayFrame[] = [];
    gateway.onFrame((_session, frame) => {
      dispatched.push(frame);
    });

    // First connection — send seq 0, 1
    const client1 = await connectClient(port);
    await client1.opened;
    client1.ws.send(createConnectMessage());
    await waitForMessages(client1.messages, 1);

    client1.ws.send(
      JSON.stringify({ kind: "request", id: "r0", seq: 0, timestamp: Date.now(), payload: null }),
    );
    client1.ws.send(
      JSON.stringify({ kind: "request", id: "r1", seq: 1, timestamp: Date.now(), payload: null }),
    );
    await waitForMessages(client1.messages, 3);
    expect(dispatched).toHaveLength(2);

    // Disconnect
    client1.ws.close();
    await client1.closed;

    // Reconnect as a new session — sends from seq 0 again (new tracker)
    const client2 = await connectClient(port);
    await client2.opened;
    client2.ws.send(createConnectMessage());
    await waitForMessages(client2.messages, 1);

    client2.ws.send(
      JSON.stringify({ kind: "request", id: "r2", seq: 0, timestamp: Date.now(), payload: null }),
    );
    await waitForMessages(client2.messages, 2);

    // Total dispatched: 2 from first connection + 1 from second
    expect(dispatched).toHaveLength(3);
    expect(dispatched[2]?.id).toBe("r2");

    client2.ws.close();
  });

  test("backpressure: frames dropped when buffer is critical", async () => {
    transport = createBunTransport();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s-bp",
      agentId: "a",
      metadata: {},
    });
    // Tiny buffer: 50 bytes max per connection, low watermark
    gateway = createGateway(
      { maxBufferBytesPerConnection: 50, backpressureHighWatermark: 0.5 },
      { transport, auth },
    );
    await gateway.start(0);

    const dispatched: GatewayFrame[] = [];
    gateway.onFrame((_session, frame) => {
      dispatched.push(frame);
    });

    const { ws, messages, opened } = await connectClient(transport.port());
    await opened;

    ws.send(createConnectMessage());
    await waitForMessages(messages, 1);

    // First frame will be recorded against the buffer (~80 bytes of JSON > 50 limit → critical)
    ws.send(
      JSON.stringify({
        kind: "request",
        id: "bp-0",
        seq: 0,
        timestamp: Date.now(),
        payload: { data: "fill" },
      }),
    );
    await waitForMessages(messages, 2); // ack for first frame

    // First frame should have been dispatched (it gets accepted before bp is recorded)
    expect(dispatched).toHaveLength(1);

    // Second frame arrives while buffer is in critical state — should be dropped
    ws.send(
      JSON.stringify({
        kind: "request",
        id: "bp-1",
        seq: 1,
        timestamp: Date.now(),
        payload: { data: "dropped" },
      }),
    );
    // Give time for processing
    await new Promise((r) => setTimeout(r, 200));

    // Second frame should NOT have been dispatched (dropped due to critical backpressure)
    expect(dispatched).toHaveLength(1);

    ws.close();
  });

  test("version negotiation: client range vs server range", async () => {
    transport = createBunTransport();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "e2e-negotiate",
      agentId: "a",
      metadata: {},
    });
    // Server supports protocol versions 1-3
    gateway = createGateway(
      { minProtocolVersion: 1, maxProtocolVersion: 3 },
      { transport, auth },
    );
    await gateway.start(0);

    const { ws, messages, opened } = await connectClient(transport.port());
    await opened;

    // Client supports protocol versions 2-5 → negotiated = 3
    ws.send(createConnectMessage("tok", { minProtocol: 2, maxProtocol: 5 }));
    await waitForMessages(messages, 1);

    const ack = JSON.parse(messages[0] as string);
    expect(ack.kind).toBe("ack");
    expect(ack.payload.protocol).toBe(3);

    ws.close();
  });

  test("version mismatch closes with 4010", async () => {
    transport = createBunTransport();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "e2e-mismatch",
      agentId: "a",
      metadata: {},
    });
    // Server only supports protocol versions 3-5
    gateway = createGateway(
      { minProtocolVersion: 3, maxProtocolVersion: 5 },
      { transport, auth },
    );
    await gateway.start(0);

    const { ws, messages, opened, closed } = await connectClient(transport.port());
    await opened;

    // Client only speaks protocol 1
    ws.send(createConnectMessage("tok", { minProtocol: 1, maxProtocol: 2 }));

    await waitForMessages(messages, 1);
    const errFrame = JSON.parse(messages[0] as string);
    expect(errFrame.kind).toBe("error");
    expect(errFrame.payload.code).toBe("PROTOCOL_MISMATCH");

    const closeEvt = await closed;
    expect(closeEvt.code).toBe(4010);
  });

  test("auth timeout when client never sends token", async () => {
    transport = createBunTransport();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s",
      agentId: "a",
      metadata: {},
    });
    gateway = createGateway({ authTimeoutMs: 200 }, { transport, auth });
    await gateway.start(0);

    const { ws, closed, opened } = await connectClient(transport.port());
    await opened;

    // Don't send anything — wait for timeout
    const closeEvt = await closed;
    expect(closeEvt.code).toBe(4001);

    ws.close();
  });

  test("webhook POST dispatches through gateway onFrame pipeline", async () => {
    transport = createBunTransport();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s-wh",
      agentId: "a",
      metadata: {},
    });

    gateway = createGateway({ webhookPort: 0 }, { transport, auth });
    await gateway.start(0);

    const received: Array<{ session: Session; frame: GatewayFrame }> = [];
    gateway.onFrame((session, frame) => {
      received.push({ session, frame });
    });

    const whPort = gateway.webhookPort();
    expect(whPort).toBeDefined();

    // Real HTTP POST to the webhook server
    const res = await fetch(`http://localhost:${whPort}/webhook/slack/acme`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Peer": "ext-service",
      },
      body: JSON.stringify({ event: "message.created", text: "hello from webhook" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; frameId: string };
    expect(body.ok).toBe(true);

    // Frame should have been dispatched through the gateway onFrame pipeline
    expect(received).toHaveLength(1);
    expect(received[0]!.session.routing?.channel).toBe("slack");
    expect(received[0]!.session.routing?.account).toBe("acme");
    expect(received[0]!.session.routing?.peer).toBe("ext-service");
    expect(received[0]!.frame.kind).toBe("event");
    expect(received[0]!.frame.payload).toEqual({
      event: "message.created",
      text: "hello from webhook",
    });
  });

  test("webhook with routing config resolves agentId from bindings", async () => {
    transport = createBunTransport();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s-wh-route",
      agentId: "a",
      metadata: {},
    });

    gateway = createGateway(
      {
        webhookPort: 0,
        routing: {
          scopingMode: "per-channel-peer",
          bindings: [
            { pattern: "slack:*", agentId: "slack-handler" },
          ],
        },
      },
      { transport, auth },
    );
    await gateway.start(0);

    const received: Array<{ session: Session; frame: GatewayFrame }> = [];
    gateway.onFrame((session, frame) => {
      received.push({ session, frame });
    });

    const whPort = gateway.webhookPort();

    const res = await fetch(`http://localhost:${whPort}/webhook/slack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "routed" }),
    });
    expect(res.status).toBe(200);

    expect(received).toHaveLength(1);
    // Routing should have resolved agentId to "slack-handler"
    expect(received[0]!.session.agentId).toBe("slack-handler");
  });

  test("scheduler fires frames received by onFrame", async () => {
    transport = createBunTransport();
    const auth = createTestAuthenticator({
      ok: true,
      sessionId: "s-sched",
      agentId: "a",
      metadata: {},
    });

    const dispatched: Array<{ session: Session; frame: GatewayFrame }> = [];

    gateway = createGateway(
      {
        schedulers: [
          { id: "test-tick", intervalMs: 100, agentId: "ticker-agent" },
        ],
      },
      { transport, auth },
    );
    await gateway.start(0);

    gateway.onFrame((session, frame) => {
      dispatched.push({ session, frame });
    });

    // Wait for at least one tick
    await new Promise((r) => setTimeout(r, 250));

    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    expect(dispatched[0]!.session.agentId).toBe("ticker-agent");
    expect(dispatched[0]!.session.metadata).toEqual({ schedulerId: "test-tick" });
    expect(dispatched[0]!.frame.kind).toBe("event");
    expect(dispatched[0]!.frame.payload).toEqual({
      schedulerId: "test-tick",
      type: "tick",
    });
  });
});
