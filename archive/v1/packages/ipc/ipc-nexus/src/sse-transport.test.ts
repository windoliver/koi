import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createSseTransport } from "./sse-transport.js";

// Capture the REAL fetch before any other test file can mock globalThis.fetch
const realFetch = globalThis.fetch;

/** Poll a condition with short intervals until true or timeout. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await Bun.sleep(intervalMs);
  }
}

/**
 * Helper: create a Bun.serve() SSE mock that streams events to connected clients.
 * Returns a controller to push SSE frames and close connections.
 */
function createSseServer(): {
  readonly url: string;
  readonly push: (frame: string) => void;
  readonly close: () => void;
  readonly server: ReturnType<typeof Bun.serve>;
  readonly connectionCount: () => number;
  readonly lastHeaders: () => Headers | undefined;
} {
  const writers: WritableStreamDefaultWriter<Uint8Array>[] = [];
  const encoder = new TextEncoder();
  // let justified: mutable tracking of connections and headers
  let connections = 0;
  let headers: Headers | undefined;

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      headers = req.headers;
      connections += 1;

      const { readable, writable } = new TransformStream<Uint8Array>();
      const writer = writable.getWriter();
      writers.push(writer);

      // Send initial keepalive to unblock fetch() — Bun's fetch waits for first chunk
      writer.write(encoder.encode(":keepalive\n\n")).catch(() => {});

      return new Response(readable, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/api/v2/events/stream`,
    push(frame: string) {
      const data = encoder.encode(frame);
      for (const writer of writers) {
        writer.write(data).catch(() => {
          // Writer may be closed — ignore
        });
      }
    },
    close() {
      for (const writer of writers) {
        writer.close().catch(() => {});
      }
      writers.length = 0;
      server.stop(true);
    },
    server,
    connectionCount: () => connections,
    lastHeaders: () => headers,
  };
}

describe("createSseTransport", () => {
  // let justified: server reference for cleanup
  let sseServer: ReturnType<typeof createSseServer>;

  beforeEach(() => {
    sseServer = createSseServer();
  });

  afterEach(() => {
    sseServer.close();
  });

  test("connected() returns false before start", () => {
    const transport = createSseTransport({
      url: sseServer.url,
      agentId: "test-agent",
      fetchImpl: realFetch,
    });
    expect(transport.connected()).toBe(false);
    transport.stop();
  });

  test("connects and becomes connected after start", async () => {
    const transport = createSseTransport({
      url: sseServer.url,
      agentId: "test-agent",
      fetchImpl: realFetch,
    });

    transport.start();
    await waitFor(() => transport.connected());

    expect(transport.connected()).toBe(true);
    transport.stop();
  });

  test("sends agent ID header", async () => {
    const transport = createSseTransport({
      url: sseServer.url,
      agentId: "my-agent",
      fetchImpl: realFetch,
    });

    transport.start();
    await waitFor(() => transport.connected());

    expect(sseServer.lastHeaders()?.get("x-agent-id")).toBe("my-agent");
    transport.stop();
  });

  test("sends auth token when provided", async () => {
    const transport = createSseTransport({
      url: sseServer.url,
      agentId: "test-agent",
      authToken: "secret-123",
      fetchImpl: realFetch,
    });

    transport.start();
    await waitFor(() => transport.connected());

    expect(sseServer.lastHeaders()?.get("authorization")).toBe("Bearer secret-123");
    transport.stop();
  });

  test("fires notification on SSE data event", async () => {
    const onNotify = mock(() => {});
    const transport = createSseTransport({
      url: sseServer.url,
      agentId: "test-agent",
      fetchImpl: realFetch,
    });
    transport.onNotification(onNotify);

    transport.start();
    await waitFor(() => transport.connected());

    sseServer.push("id: 1\nevent: ipc.inbox.new\ndata: {}\n\n");
    await waitFor(() => onNotify.mock.calls.length > 0);

    expect(onNotify).toHaveBeenCalled();
    transport.stop();
  });

  test("fires notification for each event", async () => {
    const onNotify = mock(() => {});
    const transport = createSseTransport({
      url: sseServer.url,
      agentId: "test-agent",
      fetchImpl: realFetch,
    });
    transport.onNotification(onNotify);

    transport.start();
    await waitFor(() => transport.connected());

    sseServer.push("data: event1\n\ndata: event2\n\n");
    await waitFor(() => onNotify.mock.calls.length >= 2);

    expect(onNotify.mock.calls.length).toBeGreaterThanOrEqual(2);
    transport.stop();
  });

  test("unsubscribe removes notification handler", async () => {
    const onNotify = mock(() => {});
    const transport = createSseTransport({
      url: sseServer.url,
      agentId: "test-agent",
      fetchImpl: realFetch,
    });
    const unsub = transport.onNotification(onNotify);

    transport.start();
    await waitFor(() => transport.connected());

    unsub();
    sseServer.push("data: after-unsub\n\n");
    await Bun.sleep(100);

    expect(onNotify).not.toHaveBeenCalled();
    transport.stop();
  });

  test("stop() disconnects and prevents reconnection", async () => {
    const transport = createSseTransport({
      url: sseServer.url,
      agentId: "test-agent",
      fetchImpl: realFetch,
    });

    transport.start();
    await waitFor(() => transport.connected());
    expect(transport.connected()).toBe(true);

    transport.stop();
    // stop() is synchronous in setting state
    expect(transport.connected()).toBe(false);
  });

  test("stop() via external AbortSignal", async () => {
    const controller = new AbortController();
    const transport = createSseTransport({
      url: sseServer.url,
      agentId: "test-agent",
      signal: controller.signal,
      fetchImpl: realFetch,
    });

    transport.start();
    await waitFor(() => transport.connected());
    expect(transport.connected()).toBe(true);

    controller.abort();
    await waitFor(() => !transport.connected());
    expect(transport.connected()).toBe(false);
  });

  test("reconnects after server closes connection", async () => {
    const transport = createSseTransport({
      url: sseServer.url,
      agentId: "test-agent",
      reconnectMinMs: 50,
      fetchImpl: realFetch,
    });

    transport.start();
    await waitFor(() => sseServer.connectionCount() >= 1);
    expect(sseServer.connectionCount()).toBe(1);

    // Close server-side writers — transport should detect disconnect
    sseServer.close();
    await waitFor(() => !transport.connected());
    expect(transport.connected()).toBe(false);

    transport.stop();
  });

  test("start() is idempotent when already running", async () => {
    const transport = createSseTransport({
      url: sseServer.url,
      agentId: "test-agent",
      fetchImpl: realFetch,
    });

    transport.start();
    transport.start(); // Should not create duplicate connections
    await waitFor(() => transport.connected());

    expect(sseServer.connectionCount()).toBe(1);
    transport.stop();
  });
});
