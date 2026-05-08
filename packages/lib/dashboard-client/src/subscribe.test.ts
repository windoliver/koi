import { describe, expect, test } from "bun:test";
import type { KoiError } from "@koi/core";
import type { WsEvent } from "@koi/dashboard-types";
import {
  createFetchSseAdapter,
  openSubscription,
  type SseAdapter,
  type SseConnection,
} from "./subscribe.js";

function makeBatch(events: readonly unknown[], seq = 1): string {
  return `event: batch\ndata: ${JSON.stringify({ seq, timestampMs: 123, events })}\n\n`;
}

function makeStreamHarness(contentType = "text/event-stream"): {
  readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  readonly openUrls: string[];
  readonly cancelCount: number;
  push(chunk: string): void;
  close(): void;
  fail(error: unknown): void;
} {
  const openUrls: string[] = [];
  let cancelCount = 0;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(startController) {
      controller = startController;
    },
    cancel() {
      cancelCount += 1;
    },
  });
  return {
    openUrls,
    get cancelCount(): number {
      return cancelCount;
    },
    fetchImpl: async (url: string, init?: RequestInit): Promise<Response> => {
      openUrls.push(url);
      expect(init?.headers).toEqual({ accept: "text/event-stream" });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": contentType },
      });
    },
    push: (chunk: string): void => {
      try {
        controller?.enqueue(encoder.encode(chunk));
      } catch {
        // ignored: the test already closed or errored the stream
      }
    },
    close: (): void => {
      try {
        controller?.close();
      } catch {
        // ignored: the test already closed or errored the stream
      }
    },
    fail: (error: unknown): void => {
      try {
        controller?.error(error);
      } catch {
        // ignored: the test already closed or errored the stream
      }
    },
  };
}

function makeStatusHarness(
  status: number,
  body = "",
  contentType = "text/plain",
): {
  readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  readonly openUrls: string[];
} {
  const openUrls: string[] = [];
  return {
    openUrls,
    fetchImpl: async (url: string, init?: RequestInit): Promise<Response> => {
      openUrls.push(url);
      expect(init?.headers).toEqual({ accept: "text/event-stream" });
      return new Response(body, {
        status,
        headers: { "content-type": contentType },
      });
    },
  };
}

function metricEvent(): WsEvent {
  return {
    v: 1,
    kind: "metric",
    points: [{ name: "cpu", value: 1, timestampMs: 1 }],
  };
}

describe("openSubscription", () => {
  test("passes the base URL and topics to the adapter", () => {
    let seenUrl = "";
    let seenTopics: readonly string[] = [];
    let closed = 0;
    const adapter: SseAdapter = {
      open: (url, topics): SseConnection => {
        seenUrl = url;
        seenTopics = topics;
        return {
          close: (): void => {
            closed += 1;
          },
        };
      },
    };
    const teardown = openSubscription(adapter, "http://h:1", ["metric", "trace"], {
      onEvent: () => undefined,
    });
    expect(seenUrl).toBe("http://h:1");
    expect(seenTopics).toEqual(["metric", "trace"]);
    teardown();
    expect(closed).toBe(1);
  });
});

describe("createFetchSseAdapter", () => {
  test("dispatches each valid event from a batch frame", async () => {
    const harness = makeStreamHarness();
    const seen: WsEvent[] = [];
    const adapter = createFetchSseAdapter(harness.fetchImpl);
    const teardown = adapter.open("http://h:1", ["metric"], {
      onEvent: (event) => seen.push(event),
    });

    harness.push(makeBatch([metricEvent()]));
    await waitFor(() => seen.length === 1);

    expect(harness.openUrls[0]).toBe("http://h:1/api/events?topics=metric");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("metric");
    teardown.close();
  });

  test("deduplicates repeated batch seq values within one connection", async () => {
    const harness = makeStreamHarness();
    const seen: WsEvent[] = [];
    const adapter = createFetchSseAdapter(harness.fetchImpl);
    const teardown = adapter.open("http://h:1", ["metric"], {
      onEvent: (event) => seen.push(event),
    });

    harness.push(makeBatch([metricEvent()], 7));
    harness.push(makeBatch([metricEvent()], 7));
    await waitFor(() => seen.length === 1);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("metric");
    teardown.close();
  });

  test("encodes multiple topics as one comma-joined query param", async () => {
    const harness = makeStreamHarness();
    const adapter = createFetchSseAdapter(harness.fetchImpl);
    const teardown = adapter.open("http://h:1", ["metric", "trace"], {
      onEvent: () => undefined,
    });

    expect(harness.openUrls[0]).toBe("http://h:1/api/events?topics=metric%2Ctrace");
    teardown.close();
  });

  test("ignores malformed batch payloads and malformed events inside a batch", async () => {
    const harness = makeStreamHarness();
    const seen: WsEvent[] = [];
    const adapter = createFetchSseAdapter(harness.fetchImpl);
    const teardown = adapter.open("http://h:1", ["metric"], {
      onEvent: (event) => seen.push(event),
    });

    harness.push("event: batch\ndata: not-json\n\n");
    harness.push(
      `event: batch\ndata: ${JSON.stringify({
        seq: 1,
        timestampMs: 123,
        events: [{ kind: "metric" }, metricEvent()],
      })}\n\n`,
    );
    await waitFor(() => seen.length === 1);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("metric");
    teardown.close();
  });

  test("surfaces a retryable EXTERNAL error when the stream fails", async () => {
    const harness = makeStreamHarness();
    const errors: KoiError[] = [];
    const adapter = createFetchSseAdapter(harness.fetchImpl);
    adapter.open("http://h:1", ["metric"], {
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
    });

    harness.fail(new Error("boom"));
    await waitFor(() => errors.length === 1);

    expect(errors[0]?.code).toBe("EXTERNAL");
    expect(errors[0]?.retryable).toBe(true);
  });

  test("rejects non-event-stream content-type and cancels the body", async () => {
    const harness = makeStreamHarness("text/plain");
    const errors: KoiError[] = [];
    const adapter = createFetchSseAdapter(harness.fetchImpl);
    adapter.open("http://h:1", ["metric"], {
      onEvent: () => undefined,
      onError: (error) => errors.push(error),
    });

    await waitFor(() => errors.length === 1);
    expect(errors[0]?.code).toBe("EXTERNAL");
    expect(errors[0]?.retryable).toBe(true);
    expect(harness.cancelCount).toBe(1);
  });

  test("handler failure cancels the SSE body before surfacing EXTERNAL", async () => {
    const harness = makeStreamHarness();
    const errors: KoiError[] = [];
    const adapter = createFetchSseAdapter(harness.fetchImpl);
    adapter.open("http://h:1", ["metric"], {
      onEvent: () => {
        throw new Error("boom");
      },
      onError: (error) => errors.push(error),
    });

    harness.push(makeBatch([metricEvent()]));
    await waitFor(() => errors.length === 1);
    expect(errors[0]?.code).toBe("EXTERNAL");
    expect(errors[0]?.retryable).toBe(true);
    expect(harness.cancelCount).toBe(1);
  });

  test("404 or other failed /api/events responses report retryable EXTERNAL and never fall back to WebSocket", async () => {
    const originalWebSocket = globalThis.WebSocket;
    let webSocketConstructed = false;
    globalThis.WebSocket = class {
      constructor() {
        webSocketConstructed = true;
        throw new Error("WebSocket fallback should not be used");
      }
    } as unknown as typeof WebSocket;

    try {
      for (const status of [404, 503] as const) {
        const harness = makeStatusHarness(status);
        const errors: KoiError[] = [];
        const adapter = createFetchSseAdapter(harness.fetchImpl);
        adapter.open("http://h:1", ["metric"], {
          onEvent: () => undefined,
          onError: (error) => errors.push(error),
        });

        await waitFor(() => errors.length === 1);
        expect(harness.openUrls).toEqual(["http://h:1/api/events?topics=metric"]);
        expect(errors[0]?.code).toBe("EXTERNAL");
        expect(errors[0]?.retryable).toBe(true);
        expect(webSocketConstructed).toBe(false);
        webSocketConstructed = false;
      }
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  test("caller teardown suppresses onClose", async () => {
    const harness = makeStreamHarness();
    let closes = 0;
    const adapter = createFetchSseAdapter(harness.fetchImpl);
    const teardown = adapter.open("http://h:1", ["metric"], {
      onEvent: () => undefined,
      onClose: () => {
        closes += 1;
      },
    });

    teardown.close();
    harness.close();
    await waitFor(() => true);
    expect(closes).toBe(0);
  });

  test("stream end fires onClose exactly once", async () => {
    const harness = makeStreamHarness();
    let closes = 0;
    const adapter = createFetchSseAdapter(harness.fetchImpl);
    adapter.open("http://h:1", ["metric"], {
      onEvent: () => undefined,
      onClose: () => {
        closes += 1;
      },
    });

    harness.close();
    await waitFor(() => closes === 1);
    expect(closes).toBe(1);
  });

  test("seq high-water mark advances strictly — skipped seq numbers are still ignored if a later batch lands first", async () => {
    // Guards the bounded-memory dedup invariant: a delayed earlier batch must
    // not replay events after a higher-seq batch has been observed.
    const harness = makeStreamHarness();
    const seen: WsEvent[] = [];
    const adapter = createFetchSseAdapter(harness.fetchImpl);
    const teardown = adapter.open("http://h:1", ["metric"], {
      onEvent: (event) => seen.push(event),
    });

    harness.push(makeBatch([metricEvent()], 5));
    await waitFor(() => seen.length === 1);
    // A late-delivered older batch (seq=3) must be dropped by the high-water
    // mark, even though we have not seen seq=3 before.
    harness.push(makeBatch([metricEvent()], 3));
    harness.push(makeBatch([metricEvent()], 6));
    await waitFor(() => seen.length === 2);

    expect(seen).toHaveLength(2);
    teardown.close();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
