/**
 * SSE parser tests — ported from @koi/tui for the shared implementation.
 */

import { describe, expect, test } from "bun:test";
import { consumeSSEStream, type SSEEvent, SSEParser } from "./sse-parser.js";

describe("SSEParser", () => {
  test("parses a simple data event", () => {
    const parser = new SSEParser();
    const events = parser.feed("data: hello\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("message");
    expect(events[0]?.data).toBe("hello");
  });

  test("parses event with custom type", () => {
    const parser = new SSEParser();
    const events = parser.feed("event: custom\ndata: payload\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("custom");
    expect(events[0]?.data).toBe("payload");
  });

  test("joins multi-line data with newlines", () => {
    const parser = new SSEParser();
    const events = parser.feed("data: line1\ndata: line2\ndata: line3\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("line1\nline2\nline3");
  });

  test("parses multiple events in one chunk", () => {
    const parser = new SSEParser();
    const events = parser.feed("data: first\n\ndata: second\n\n");
    expect(events).toHaveLength(2);
    expect(events[0]?.data).toBe("first");
    expect(events[1]?.data).toBe("second");
  });

  test("handles event split across two chunks", () => {
    const parser = new SSEParser();
    const e1 = parser.feed("data: hel");
    expect(e1).toHaveLength(0);
    const e2 = parser.feed("lo\n\n");
    expect(e2).toHaveLength(1);
    expect(e2[0]?.data).toBe("hello");
  });

  test("handles line split at \\n boundary", () => {
    const parser = new SSEParser();
    const e1 = parser.feed("data: hello\n");
    expect(e1).toHaveLength(0);
    const e2 = parser.feed("\n");
    expect(e2).toHaveLength(1);
    expect(e2[0]?.data).toBe("hello");
  });

  test("ignores comment lines", () => {
    const parser = new SSEParser();
    const events = parser.feed(": this is a comment\ndata: real\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("real");
  });

  test("ignores keepalive (empty comment)", () => {
    const parser = new SSEParser();
    const events = parser.feed(":\n\n");
    expect(events).toHaveLength(0);
  });

  test("handles \\r\\n line endings", () => {
    const parser = new SSEParser();
    const events = parser.feed("data: hello\r\n\r\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("hello");
  });

  test("handles \\r line endings", () => {
    const parser = new SSEParser();
    const events = parser.feed("data: hello\r\r");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("hello");
  });

  test("handles mixed line endings", () => {
    const parser = new SSEParser();
    const events = parser.feed("data: a\r\ndata: b\rdata: c\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("a\nb\nc");
  });

  test("tracks id field for reconnection", () => {
    const parser = new SSEParser();
    parser.feed("id: 42\ndata: hello\n\n");
    expect(parser.lastId).toBe("42");
  });

  test("id persists across events", () => {
    const parser = new SSEParser();
    parser.feed("id: 1\ndata: first\n\ndata: second\n\n");
    expect(parser.lastId).toBe("1");
  });

  test("id updates when new id field received", () => {
    const parser = new SSEParser();
    parser.feed("id: 1\ndata: first\n\nid: 2\ndata: second\n\n");
    expect(parser.lastId).toBe("2");
  });

  test("ignores id containing null character", () => {
    const parser = new SSEParser();
    parser.feed("id: 1\ndata: first\n\n");
    parser.feed("id: bad\0id\ndata: second\n\n");
    expect(parser.lastId).toBe("1");
  });

  test("parses retry field", () => {
    const parser = new SSEParser();
    const events = parser.feed("retry: 3000\ndata: hello\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.retry).toBe(3000);
  });

  test("ignores non-numeric retry", () => {
    const parser = new SSEParser();
    const events = parser.feed("retry: not-a-number\ndata: hello\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.retry).toBeUndefined();
  });

  test("ignores negative retry", () => {
    const parser = new SSEParser();
    const events = parser.feed("retry: -1\ndata: hello\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.retry).toBeUndefined();
  });

  test("strips single leading space from value", () => {
    const parser = new SSEParser();
    const events = parser.feed("data: hello\n\n");
    expect(events[0]?.data).toBe("hello");
  });

  test("preserves value when no space after colon", () => {
    const parser = new SSEParser();
    const events = parser.feed("data:hello\n\n");
    expect(events[0]?.data).toBe("hello");
  });

  test("preserves multiple spaces (only strips first)", () => {
    const parser = new SSEParser();
    const events = parser.feed("data:  two spaces\n\n");
    expect(events[0]?.data).toBe(" two spaces");
  });

  test("handles field-only line (no colon)", () => {
    const parser = new SSEParser();
    const events = parser.feed("data\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("");
  });

  test("handles data with colon in value", () => {
    const parser = new SSEParser();
    const events = parser.feed('data: {"key": "value"}\n\n');
    expect(events[0]?.data).toBe('{"key": "value"}');
  });

  test("handles empty data field", () => {
    const parser = new SSEParser();
    const events = parser.feed("data: \n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("");
  });

  test("ignores unknown fields", () => {
    const parser = new SSEParser();
    const events = parser.feed("unknown: value\ndata: hello\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("hello");
  });

  test("does not dispatch event without data lines", () => {
    const parser = new SSEParser();
    const events = parser.feed("event: ping\n\n");
    expect(events).toHaveLength(0);
  });

  test("handles UTF-8 multi-byte characters", () => {
    const parser = new SSEParser();
    const events = parser.feed("data: 你好世界\n\n");
    expect(events[0]?.data).toBe("你好世界");
  });

  test("handles emoji in data", () => {
    const parser = new SSEParser();
    const events = parser.feed("data: Hello 🌍🚀\n\n");
    expect(events[0]?.data).toBe("Hello 🌍🚀");
  });

  test("handles UTF-8 split across chunks", () => {
    const parser = new SSEParser();
    const e1 = parser.feed("data: caf");
    expect(e1).toHaveLength(0);
    const e2 = parser.feed("é\n\n");
    expect(e2).toHaveLength(1);
    expect(e2[0]?.data).toBe("café");
  });

  test("reset clears buffer but preserves lastId", () => {
    const parser = new SSEParser();
    parser.feed("id: 42\ndata: partial");
    expect(parser.lastId).toBe("42");
    parser.reset();
    const events = parser.feed("data: fresh\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("fresh");
    expect(parser.lastId).toBe("42");
  });

  test("handles realistic dashboard event batch", () => {
    const parser = new SSEParser();
    const batch = JSON.stringify({
      events: [{ kind: "agent", subKind: "status_changed" }],
      seq: 1,
      timestamp: 1234567890,
    });
    const events = parser.feed(`id: 1\ndata: ${batch}\n\n`);
    expect(events).toHaveLength(1);
    const parsed: unknown = JSON.parse(events[0]?.data ?? "{}");
    expect(parsed).toEqual({
      events: [{ kind: "agent", subKind: "status_changed" }],
      seq: 1,
      timestamp: 1234567890,
    });
  });

  test("handles rapid sequence of small events", () => {
    const parser = new SSEParser();
    let chunk = "";
    for (let i = 0; i < 100; i++) {
      chunk += `id: ${String(i)}\ndata: msg-${String(i)}\n\n`;
    }
    const events = parser.feed(chunk);
    expect(events).toHaveLength(100);
    expect(events[99]?.data).toBe("msg-99");
    expect(parser.lastId).toBe("99");
  });
});

describe("consumeSSEStream", () => {
  test("consumes a simple stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("data: hello\n\n"));
        controller.enqueue(encoder.encode("data: world\n\n"));
        controller.close();
      },
    });
    const response = new Response(body);

    const received: SSEEvent[] = [];
    let closed = false;
    await consumeSSEStream(response, {
      onEvent: (e) => {
        received.push(e);
      },
      onClose: () => {
        closed = true;
      },
    });

    expect(received).toHaveLength(2);
    expect(received[0]?.data).toBe("hello");
    expect(received[1]?.data).toBe("world");
    expect(closed).toBe(true);
  });

  test("handles null body", async () => {
    const response = new Response(null);
    let closed = false;
    await consumeSSEStream(response, {
      onEvent: () => {
        throw new Error("should not be called");
      },
      onClose: () => {
        closed = true;
      },
    });
    expect(closed).toBe(true);
  });

  test("handles abort signal", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();

    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encoder.encode("data: first\n\n"));
      },
      pull() {
        return new Promise<void>((resolve) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
      },
    });
    const response = new Response(body);

    const received: SSEEvent[] = [];
    setTimeout(() => {
      controller.abort();
    }, 30);

    await consumeSSEStream(response, {
      onEvent: (e) => {
        received.push(e);
      },
      signal: controller.signal,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.data).toBe("first");
  });

  test("returns parser with lastId for reconnection", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const encoder = new TextEncoder();
        ctrl.enqueue(encoder.encode("id: 42\ndata: hello\n\n"));
        ctrl.close();
      },
    });
    const response = new Response(body);

    const parser = await consumeSSEStream(response, {
      onEvent: () => {},
    });

    expect(parser.lastId).toBe("42");
  });
});
