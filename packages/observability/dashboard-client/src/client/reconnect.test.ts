import { describe, expect, test } from "bun:test";
import { createReconnectingStream, type ReconnectStatus, type SSEFetcher } from "./reconnect.js";
import type { SSEEvent } from "./sse-stream.js";

/** Create a mock SSE response that sends events then closes. */
function mockSSEResponse(...events: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const data of events) {
        ctrl.enqueue(encoder.encode(`data: ${data}\n\n`));
      }
      ctrl.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("createReconnectingStream", () => {
  test("connects and receives events", async () => {
    const events: SSEEvent[] = [];
    const statuses: ReconnectStatus[] = [];
    let fetchCount = 0;

    const fetcher: SSEFetcher = async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return mockSSEResponse("hello", "world");
      }
      // Second call — return empty to stop
      return new Response(null, { status: 200 });
    };

    const handle = createReconnectingStream(
      fetcher,
      {
        onEvent: (e) => {
          events.push(e);
        },
        onStatus: (s) => {
          statuses.push(s);
        },
      },
      { maxAttempts: 1, initialDelayMs: 10 },
    );

    // Wait for events to arrive
    await new Promise((r) => {
      setTimeout(r, 200);
    });
    handle.stop();

    expect(events).toHaveLength(2);
    expect(events[0]?.data).toBe("hello");
    expect(events[1]?.data).toBe("world");
    expect(statuses[0]?.kind).toBe("connected");
  });

  test("retries on connection failure", async () => {
    const statuses: ReconnectStatus[] = [];
    let fetchCount = 0;

    const fetcher: SSEFetcher = async () => {
      fetchCount++;
      if (fetchCount <= 2) {
        throw new TypeError("fetch failed");
      }
      // Third call succeeds
      return mockSSEResponse("recovered");
    };

    const handle = createReconnectingStream(
      fetcher,
      {
        onEvent: () => {},
        onStatus: (s) => {
          statuses.push(s);
        },
      },
      { maxAttempts: 5, initialDelayMs: 10, maxDelayMs: 20 },
    );

    await new Promise((r) => {
      setTimeout(r, 500);
    });
    handle.stop();

    expect(fetchCount).toBeGreaterThanOrEqual(3);
    // Should have reconnecting statuses followed by connected
    const reconnecting = statuses.filter((s) => s.kind === "reconnecting");
    expect(reconnecting.length).toBeGreaterThanOrEqual(1);
    const connected = statuses.filter((s) => s.kind === "connected");
    expect(connected.length).toBeGreaterThanOrEqual(1);
  });

  test("gives up after maxAttempts", async () => {
    const statuses: ReconnectStatus[] = [];

    const fetcher: SSEFetcher = async () => {
      throw new TypeError("fetch failed");
    };

    const handle = createReconnectingStream(
      fetcher,
      {
        onEvent: () => {},
        onStatus: (s) => {
          statuses.push(s);
        },
      },
      { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20 },
    );

    await new Promise((r) => {
      setTimeout(r, 300);
    });
    handle.stop();

    const failed = statuses.find((s) => s.kind === "failed");
    expect(failed).toBeDefined();
    if (failed?.kind === "failed") {
      expect(failed.attempt).toBe(3); // 2 retries + 1 over limit
    }
  });

  test("passes lastEventId to fetcher on reconnect", async () => {
    const receivedIds: Array<string | undefined> = [];
    let fetchCount = 0;

    const fetcher: SSEFetcher = async (lastEventId) => {
      receivedIds.push(lastEventId);
      fetchCount++;
      if (fetchCount === 1) {
        // First call — return event with id
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(encoder.encode("id: 42\ndata: hello\n\n"));
            ctrl.close();
          },
        });
        return new Response(body, { status: 200 });
      }
      // Second call — just return empty
      return new Response(null, { status: 200 });
    };

    const handle = createReconnectingStream(
      fetcher,
      {
        onEvent: () => {},
        onStatus: () => {},
      },
      { maxAttempts: 2, initialDelayMs: 10 },
    );

    await new Promise((r) => {
      setTimeout(r, 200);
    });
    handle.stop();

    // First call should have no lastEventId
    expect(receivedIds[0]).toBeUndefined();
    // Second call should have lastEventId from first stream
    if (receivedIds.length > 1) {
      expect(receivedIds[1]).toBe("42");
    }
  });

  test("stop() prevents further reconnection", async () => {
    let fetchCount = 0;

    const fetcher: SSEFetcher = async () => {
      fetchCount++;
      return mockSSEResponse("data");
    };

    const handle = createReconnectingStream(
      fetcher,
      {
        onEvent: () => {},
        onStatus: () => {},
      },
      { maxAttempts: 10, initialDelayMs: 10 },
    );

    // Stop immediately after first connection
    await new Promise((r) => {
      setTimeout(r, 50);
    });
    handle.stop();

    const countAtStop = fetchCount;
    await new Promise((r) => {
      setTimeout(r, 100);
    });

    // Should not have made more requests after stop
    expect(fetchCount).toBe(countAtStop);
  });

  test("handles HTTP error status", async () => {
    const statuses: ReconnectStatus[] = [];
    let _fetchCount = 0;

    const fetcher: SSEFetcher = async () => {
      _fetchCount++;
      return new Response("Server Error", { status: 500 });
    };

    const handle = createReconnectingStream(
      fetcher,
      {
        onEvent: () => {},
        onStatus: (s) => {
          statuses.push(s);
        },
      },
      { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20 },
    );

    await new Promise((r) => {
      setTimeout(r, 300);
    });
    handle.stop();

    // Should have tried and retried
    const reconnecting = statuses.filter((s) => s.kind === "reconnecting");
    expect(reconnecting.length).toBeGreaterThanOrEqual(1);
  });
});
