/**
 * E2E tests: real Bun.serve WebSocket server + real WebSocket clients.
 * Tests the full wire path: TCP connect → WS upgrade → auth → frames → acks.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Gateway } from "../gateway.js";
import { createGateway } from "../gateway.js";
import type { BunTransport } from "../transport.js";
import { createBunTransport } from "../transport.js";
import type { GatewayFrame } from "../types.js";
import { createTestAuthenticator } from "./test-utils.js";

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

    // 1. Send auth token
    ws.send("my-e2e-token");
    await waitForMessages(messages, 1); // auth ack

    const authAck = JSON.parse(messages[0] as string);
    expect(authAck.kind).toBe("ack");
    expect(authAck.payload.sessionId).toBe("e2e-session");

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

    ws.send("bad-token");

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

    ws.send("token");
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

    ws.send("token");
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

    ws.send("token");
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
      async authenticate(_token: string) {
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
      client.ws.send("token");
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
});
