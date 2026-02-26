import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CanvasSseManager, SseEvent, SseSubscriber } from "../canvas-sse.js";
import { createCanvasSseManager, formatSseEvent } from "../canvas-sse.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

/** Create a subscriber that collects all received data as strings. */
function createMockSubscriber(): { subscriber: SseSubscriber; chunks: string[] } {
  const chunks: string[] = [];
  const subscriber: SseSubscriber = (data: Uint8Array) => {
    chunks.push(decoder.decode(data));
    return true;
  };
  return { subscriber, chunks };
}

/** Create a subscriber that returns false (simulates dead connection). */
function createDeadSubscriber(): SseSubscriber {
  return () => false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("formatSseEvent", () => {
  test("formats event to SSE wire format", () => {
    const event: SseEvent = { id: "1", event: "updated", data: '{"content":"hello"}' };
    const bytes = formatSseEvent(event);
    expect(decoder.decode(bytes)).toBe('id: 1\nevent: updated\ndata: {"content":"hello"}\n\n');
  });

  test("sanitizes newlines from id and event fields", () => {
    const event: SseEvent = { id: "1\n2", event: "up\r\ndated", data: '{"x":1}' };
    const output = decoder.decode(formatSseEvent(event));
    expect(output).toBe('id: 12\nevent: updated\ndata: {"x":1}\n\n');
  });

  test("handles multi-line data by prefixing each line", () => {
    const event: SseEvent = { id: "1", event: "updated", data: "line1\nline2\nline3" };
    const output = decoder.decode(formatSseEvent(event));
    expect(output).toBe("id: 1\nevent: updated\ndata: line1\ndata: line2\ndata: line3\n\n");
  });
});

describe("createCanvasSseManager", () => {
  let sse: CanvasSseManager;

  beforeEach(() => {
    sse = createCanvasSseManager({
      maxSubscribersPerSurface: 3,
      maxTotalSubscribers: 5,
      keepAliveIntervalMs: 60_000, // Long interval to avoid interference
    });
  });

  afterEach(() => {
    sse.dispose();
  });

  test("subscribe → publish → subscriber receives event in SSE format", () => {
    const mock = createMockSubscriber();
    const result = sse.subscribe("s1", mock.subscriber);
    expect(result.ok).toBe(true);

    const event: SseEvent = { id: "1", event: "updated", data: '{"content":"hello"}' };
    sse.publish("s1", event);

    expect(mock.chunks).toHaveLength(1);
    expect(mock.chunks[0]).toBe('id: 1\nevent: updated\ndata: {"content":"hello"}\n\n');
  });

  test("subscribe multiple → all receive published event", () => {
    const mock1 = createMockSubscriber();
    const mock2 = createMockSubscriber();
    sse.subscribe("s1", mock1.subscriber);
    sse.subscribe("s1", mock2.subscriber);

    sse.publish("s1", { id: "1", event: "updated", data: "{}" });

    expect(mock1.chunks).toHaveLength(1);
    expect(mock2.chunks).toHaveLength(1);
  });

  test("unsubscribe → subscriber stops receiving events", () => {
    const mock = createMockSubscriber();
    const result = sse.subscribe("s1", mock.subscriber);
    if (!result.ok) throw new Error("setup failed");

    result.value(); // unsubscribe

    sse.publish("s1", { id: "1", event: "updated", data: "{}" });

    expect(mock.chunks).toHaveLength(0);
    expect(sse.subscriberCount("s1")).toBe(0);
  });

  test("per-surface limit → returns RATE_LIMIT error", () => {
    for (let i = 0; i < 3; i++) {
      const mock = createMockSubscriber();
      expect(sse.subscribe("s1", mock.subscriber).ok).toBe(true);
    }

    const extra = createMockSubscriber();
    const result = sse.subscribe("s1", extra.subscriber);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
      expect(result.error.message).toContain("Per-surface");
    }
  });

  test("global limit → returns RATE_LIMIT error", () => {
    for (let i = 0; i < 5; i++) {
      const mock = createMockSubscriber();
      expect(sse.subscribe(`surface-${i}`, mock.subscriber).ok).toBe(true);
    }

    const extra = createMockSubscriber();
    const result = sse.subscribe("overflow", extra.subscriber);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
      expect(result.error.message).toContain("Global");
    }
  });

  test("close(surfaceId) → sends deleted event + removes subscribers", () => {
    const mock = createMockSubscriber();
    sse.subscribe("s1", mock.subscriber);

    sse.close("s1");

    expect(mock.chunks).toHaveLength(1);
    expect(mock.chunks[0]).toContain("event: deleted");
    expect(mock.chunks[0]).toContain('"surfaceId":"s1"');
    expect(sse.subscriberCount("s1")).toBe(0);
    expect(sse.totalSubscribers()).toBe(0);
  });

  test("dispose() → clears all state", () => {
    const mock1 = createMockSubscriber();
    const mock2 = createMockSubscriber();
    sse.subscribe("s1", mock1.subscriber);
    sse.subscribe("s2", mock2.subscriber);
    expect(sse.totalSubscribers()).toBe(2);

    sse.dispose();

    expect(sse.totalSubscribers()).toBe(0);
    expect(sse.subscriberCount("s1")).toBe(0);
    expect(sse.subscriberCount("s2")).toBe(0);
  });

  test("dead subscriber automatically removed on publish", () => {
    const dead = createDeadSubscriber();
    const alive = createMockSubscriber();
    sse.subscribe("s1", dead);
    sse.subscribe("s1", alive.subscriber);
    expect(sse.subscriberCount("s1")).toBe(2);

    sse.publish("s1", { id: "1", event: "updated", data: "{}" });

    expect(sse.subscriberCount("s1")).toBe(1);
    expect(alive.chunks).toHaveLength(1);
  });

  test("subscriberCount returns 0 for unknown surface", () => {
    expect(sse.subscriberCount("unknown")).toBe(0);
  });

  test("publish to surface with no subscribers is a no-op", () => {
    // Should not throw
    sse.publish("unknown", { id: "1", event: "updated", data: "{}" });
  });

  test("nextEventId returns monotonic IDs", () => {
    expect(sse.nextEventId("s1")).toBe("1");
    expect(sse.nextEventId("s1")).toBe("2");
    expect(sse.nextEventId("s1")).toBe("3");
    // Different surface has its own counter
    expect(sse.nextEventId("s2")).toBe("1");
  });
});
