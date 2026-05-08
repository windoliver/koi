import { describe, expect, test } from "bun:test";
import { createTuiGatewayClient } from "./tui-gateway-client.js";

type WebSocketEventName = "open" | "message" | "close" | "error";

interface FakeWebSocketController {
  readonly socket: WebSocket;
  readonly sent: string[];
  readonly open: () => void;
  readonly message: (data: string) => void;
  readonly close: () => void;
  readonly error: () => void;
}

function createFakeWebSocket(initialReadyState = 0): FakeWebSocketController {
  const sent: string[] = [];
  const listeners = new Map<WebSocketEventName, Set<(event?: unknown) => void>>();
  let readyState = initialReadyState;

  function emit(type: WebSocketEventName, event?: unknown): void {
    for (const listener of listeners.get(type) ?? []) listener(event);
  }

  const socket = {
    get readyState(): number {
      return readyState;
    },
    send: (data: string) => {
      sent.push(data);
    },
    close: () => {
      readyState = 3;
    },
    addEventListener: (type: WebSocketEventName, listener: (event?: unknown) => void) => {
      let bucket = listeners.get(type);
      if (bucket === undefined) {
        bucket = new Set();
        listeners.set(type, bucket);
      }
      bucket.add(listener);
    },
    removeEventListener: (type: WebSocketEventName, listener: (event?: unknown) => void) => {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as WebSocket;

  return {
    socket,
    sent,
    open: () => {
      readyState = 1;
      emit("open");
    },
    message: (data: string) => {
      emit("message", { data });
    },
    close: () => {
      readyState = 3;
      emit("close");
    },
    error: () => {
      emit("error");
    },
  };
}

describe("createTuiGatewayClient", () => {
  test("reconnect preserves session identity and resume watermark expectations", async () => {
    const first = createFakeWebSocket();
    const second = createFakeWebSocket();
    const sockets = [first, second];
    const client = createTuiGatewayClient({
      gatewayUrl: "ws://127.0.0.1:19500",
      clientId: "resume-client",
      authToken: "test-token",
      webSocketFactory: () => {
        const next = sockets.shift();
        if (next === undefined) {
          throw new Error("no websocket available");
        }
        return next.socket;
      },
    });

    const connectPromise = client.connect();
    first.open();
    first.message(
      JSON.stringify({
        kind: "ack",
        id: "gw-1",
        seq: 0,
        timestamp: 1,
        payload: { sessionId: "sess-123", remoteSeq: 5, protocol: 1 },
      }),
    );
    await connectPromise;

    await client.noteRemoteSeq(5);

    const reconnectPromise = client.reconnect();
    second.open();
    second.message(
      JSON.stringify({
        kind: "ack",
        id: "gw-2",
        seq: 1,
        timestamp: 2,
        payload: { sessionId: "sess-123", remoteSeq: 5, protocol: 1 },
      }),
    );
    await reconnectPromise;

    expect(client.sessionId()).toBe("sess-123");
    expect(first.socket.readyState).toBe(3);
    expect(second.sent[0]).toContain('"kind":"connect"');
  });

  test("reconnect rejects when the gateway resumes a different session", async () => {
    const first = createFakeWebSocket();
    const second = createFakeWebSocket();
    const sockets = [first, second];
    const client = createTuiGatewayClient({
      gatewayUrl: "ws://127.0.0.1:19500",
      clientId: "resume-client",
      authToken: "test-token",
      webSocketFactory: () => {
        const next = sockets.shift();
        if (next === undefined) {
          throw new Error("no websocket available");
        }
        return next.socket;
      },
    });

    const connectPromise = client.connect();
    first.open();
    first.message(
      JSON.stringify({
        kind: "ack",
        id: "gw-1",
        seq: 0,
        timestamp: 1,
        payload: { sessionId: "sess-123", remoteSeq: 5, protocol: 1 },
      }),
    );
    await connectPromise;

    await client.noteRemoteSeq(5);

    const reconnectPromise = client.reconnect();
    second.open();
    second.message(
      JSON.stringify({
        kind: "ack",
        id: "gw-2",
        seq: 1,
        timestamp: 2,
        payload: { sessionId: "sess-999", remoteSeq: 5, protocol: 1 },
      }),
    );

    await expect(reconnectPromise).rejects.toThrow("gateway resume failed");
  });

  test("reconnect rejects when the gateway ack regresses the resume watermark", async () => {
    const first = createFakeWebSocket();
    const second = createFakeWebSocket();
    const sockets = [first, second];
    const client = createTuiGatewayClient({
      gatewayUrl: "ws://127.0.0.1:19500",
      clientId: "resume-client",
      authToken: "test-token",
      webSocketFactory: () => {
        const next = sockets.shift();
        if (next === undefined) {
          throw new Error("no websocket available");
        }
        return next.socket;
      },
    });

    const connectPromise = client.connect();
    first.open();
    first.message(
      JSON.stringify({
        kind: "ack",
        id: "gw-1",
        seq: 0,
        timestamp: 1,
        payload: { sessionId: "sess-123", remoteSeq: 5, protocol: 1 },
      }),
    );
    await connectPromise;

    await client.noteRemoteSeq(5);

    const reconnectPromise = client.reconnect();
    second.open();
    second.message(
      JSON.stringify({
        kind: "ack",
        id: "gw-2",
        seq: 1,
        timestamp: 2,
        payload: { sessionId: "sess-123", remoteSeq: 4, protocol: 1 },
      }),
    );

    await expect(reconnectPromise).rejects.toThrow("gateway resume failed");
  });

  test("remote-mode boot on an already-open socket still waits for ack", async () => {
    const ws = createFakeWebSocket(1);
    const client = createTuiGatewayClient({
      gatewayUrl: "ws://127.0.0.1:19500",
      clientId: "cli-test",
      authToken: "test-token",
      webSocketFactory: () => ws.socket,
    });

    const connectPromise = client.connect();
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toContain('"kind":"connect"');

    ws.message(
      JSON.stringify({
        kind: "ack",
        id: "gw-1",
        seq: 0,
        timestamp: 1,
        payload: { sessionId: "sess-123", protocol: 1 },
      }),
    );
    await connectPromise;
    expect(client.sessionId()).toBe("sess-123");
  });

  test("waits for handshake ack before resolving and captures session id", async () => {
    const ws = createFakeWebSocket();
    const client = createTuiGatewayClient({
      gatewayUrl: "ws://127.0.0.1:19500",
      clientId: "cli-test",
      authToken: "test-token",
      webSocketFactory: () => ws.socket,
    });

    expect(client.sessionId()).toBeUndefined();
    let resolved = false;
    const connectPromise = client.connect().then(() => {
      resolved = true;
    });

    expect(ws.sent).toEqual([]);
    ws.open();
    expect(ws.sent[0]).toContain('"kind":"connect"');
    expect(ws.sent[0]).toContain('"id":"cli-test"');
    expect(resolved).toBe(false);
    expect(client.sessionId()).toBeUndefined();

    ws.message(
      JSON.stringify({
        kind: "ack",
        id: "gw-1",
        seq: 0,
        timestamp: 1,
        payload: { sessionId: "sess-123", protocol: 1 },
      }),
    );
    await connectPromise;
    expect(resolved).toBe(true);
    expect(client.sessionId()).toBe("sess-123");
  });

  test("rejects handshake on close before ack", async () => {
    const ws = createFakeWebSocket();
    const client = createTuiGatewayClient({
      gatewayUrl: "ws://127.0.0.1:19500",
      clientId: "cli-test",
      authToken: "test-token",
      webSocketFactory: () => ws.socket,
    });

    const connectPromise = client.connect();
    ws.open();
    ws.close();

    await expect(connectPromise).rejects.toThrow("gateway connect failed");
  });

  test("rejects handshake on error before ack", async () => {
    const ws = createFakeWebSocket();
    const client = createTuiGatewayClient({
      gatewayUrl: "ws://127.0.0.1:19500",
      clientId: "cli-test",
      authToken: "test-token",
      webSocketFactory: () => ws.socket,
    });

    const connectPromise = client.connect();
    ws.open();
    ws.error();

    await expect(connectPromise).rejects.toThrow("gateway connect failed");
  });

  test("cancel sends a control request for the active request", async () => {
    const ws = createFakeWebSocket(1);
    const client = createTuiGatewayClient({
      gatewayUrl: "ws://127.0.0.1:19500",
      clientId: "cli-test",
      authToken: "test-token",
      webSocketFactory: () => ws.socket,
    });

    const connectPromise = client.connect();
    ws.message(
      JSON.stringify({
        kind: "ack",
        id: "gw-1",
        seq: 0,
        timestamp: 1,
        payload: { sessionId: "sess-123", protocol: 1 },
      }),
    );
    await connectPromise;

    expect(ws.sent).toHaveLength(1);
    await client.cancel("req-1");
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[1]).toContain('"kind":"request"');
    expect(ws.sent[1]).toContain('"kind":"cancel"');
    expect(ws.sent[1]).toContain('"requestId":"req-1"');
  });

  test("run sends a request frame keyed by the provided request id", async () => {
    const ws = createFakeWebSocket(1);
    const client = createTuiGatewayClient({
      gatewayUrl: "ws://127.0.0.1:19500",
      clientId: "cli-test",
      authToken: "test-token",
      webSocketFactory: () => ws.socket,
    });

    const connectPromise = client.connect();
    ws.message(
      JSON.stringify({
        kind: "ack",
        id: "gw-1",
        seq: 0,
        timestamp: 1,
        payload: { sessionId: "sess-123", protocol: 1 },
      }),
    );
    await connectPromise;

    const stream = client.run({ requestId: "req-1", text: "hello gateway" });
    // Server replies with a terminal response frame keyed by ref=req-1.
    ws.message(
      JSON.stringify({
        kind: "response",
        id: "resp-1",
        seq: 1,
        ref: "req-1",
        timestamp: 2,
        payload: { text: "hi back" },
      }),
    );

    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[1]).toContain('"kind":"request"');
    expect(ws.sent[1]).toContain('"id":"req-1"');
    expect(ws.sent[1]).toContain('"text":"hello gateway"');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "text_delta", delta: "hi back" });
    expect(events[1]).toMatchObject({ kind: "done" });
  });

  test("dispose closes the websocket", async () => {
    const ws = createFakeWebSocket(1);
    const client = createTuiGatewayClient({
      gatewayUrl: "ws://127.0.0.1:19500",
      clientId: "cli-test",
      authToken: "test-token",
      webSocketFactory: () => ws.socket,
    });

    const connectPromise = client.connect();
    ws.message(
      JSON.stringify({
        kind: "ack",
        id: "gw-1",
        seq: 0,
        timestamp: 1,
        payload: { sessionId: "sess-123", protocol: 1 },
      }),
    );
    await connectPromise;

    await client.dispose();
    expect(ws.socket.readyState).toBe(3);
  });

  test("run yields done with stopReason error when an error frame arrives for the request", async () => {
    const ws = createFakeWebSocket(1);
    const client = createTuiGatewayClient({
      gatewayUrl: "ws://127.0.0.1:19500",
      clientId: "cli-test",
      authToken: "test-token",
      webSocketFactory: () => ws.socket,
    });
    const connectPromise = client.connect();
    ws.message(
      JSON.stringify({
        kind: "ack",
        id: "gw-1",
        seq: 0,
        timestamp: 1,
        payload: { sessionId: "sess-123", protocol: 1 },
      }),
    );
    await connectPromise;

    const stream = client.run({ requestId: "req-err", text: "boom" });
    ws.message(
      JSON.stringify({
        kind: "error",
        id: "err-1",
        seq: 1,
        ref: "req-err",
        timestamp: 2,
        payload: { code: "NO_RUNTIME", message: "no handler" },
      }),
    );

    const events: unknown[] = [];
    for await (const e of stream) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "done", output: { stopReason: "error" } });
  });

  test("run ignores frames with mismatched ref so concurrent requests don't cross-talk", async () => {
    const ws = createFakeWebSocket(1);
    const client = createTuiGatewayClient({
      gatewayUrl: "ws://127.0.0.1:19500",
      clientId: "cli-test",
      authToken: "test-token",
      webSocketFactory: () => ws.socket,
    });
    const connectPromise = client.connect();
    ws.message(
      JSON.stringify({
        kind: "ack",
        id: "gw-1",
        seq: 0,
        timestamp: 1,
        payload: { sessionId: "sess-123", protocol: 1 },
      }),
    );
    await connectPromise;

    const stream = client.run({ requestId: "req-A", text: "for A" });
    // Response for a different request — must not terminate stream A.
    ws.message(
      JSON.stringify({
        kind: "response",
        id: "resp-other",
        seq: 1,
        ref: "req-OTHER",
        timestamp: 2,
        payload: { text: "wrong stream" },
      }),
    );
    // Now the right one.
    ws.message(
      JSON.stringify({
        kind: "response",
        id: "resp-A",
        seq: 2,
        ref: "req-A",
        timestamp: 3,
        payload: { text: "right stream" },
      }),
    );

    const events: unknown[] = [];
    for await (const e of stream) events.push(e);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "text_delta", delta: "right stream" });
    expect(events[1]).toMatchObject({ kind: "done", output: { stopReason: "completed" } });
  });

  test("run yields done with stopReason error if the websocket closes before a terminal frame", async () => {
    const ws = createFakeWebSocket(1);
    const client = createTuiGatewayClient({
      gatewayUrl: "ws://127.0.0.1:19500",
      clientId: "cli-test",
      authToken: "test-token",
      webSocketFactory: () => ws.socket,
    });
    const connectPromise = client.connect();
    ws.message(
      JSON.stringify({
        kind: "ack",
        id: "gw-1",
        seq: 0,
        timestamp: 1,
        payload: { sessionId: "sess-123", protocol: 1 },
      }),
    );
    await connectPromise;

    const stream = client.run({ requestId: "req-disco", text: "will disconnect" });
    ws.close();

    const events: unknown[] = [];
    for await (const e of stream) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "done", output: { stopReason: "error" } });
  });
});
