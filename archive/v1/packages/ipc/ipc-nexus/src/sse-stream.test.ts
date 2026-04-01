import { describe, expect, test } from "bun:test";
import type { SseEvent } from "./sse-stream.js";
import { parseSseStream } from "./sse-stream.js";

/** Helper: encode string chunks into a ReadableStream<Uint8Array>. */
function createStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const encoded = chunks.map((c) => encoder.encode(c));
  // let justified: index tracks which chunk to enqueue next
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < encoded.length) {
        const chunk = encoded[index];
        if (chunk !== undefined) controller.enqueue(chunk);
        index += 1;
      } else {
        controller.close();
      }
    },
  });
}

/** Collect all events from a stream. */
async function collectEvents(chunks: readonly string[]): Promise<readonly SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(createStream(chunks))) {
    events.push(event);
  }
  return events;
}

describe("parseSseStream", () => {
  test("parses a single event", async () => {
    const events = await collectEvents(["data: hello\n\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("hello");
  });

  test("parses event with id and event type", async () => {
    const events = await collectEvents(["id: 42\nevent: notification\ndata: payload\n\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("42");
    expect(events[0]?.event).toBe("notification");
    expect(events[0]?.data).toBe("payload");
  });

  test("parses retry field", async () => {
    const events = await collectEvents(["retry: 5000\ndata: reconnect\n\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.retry).toBe(5000);
    expect(events[0]?.data).toBe("reconnect");
  });

  test("ignores invalid retry values", async () => {
    const events = await collectEvents(["retry: abc\ndata: test\n\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.retry).toBeUndefined();
  });

  test("handles multiple events", async () => {
    const events = await collectEvents(["data: first\n\ndata: second\n\n"]);
    expect(events).toHaveLength(2);
    expect(events[0]?.data).toBe("first");
    expect(events[1]?.data).toBe("second");
  });

  test("ignores comment lines", async () => {
    const events = await collectEvents([":keepalive\ndata: real\n\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("real");
  });

  test("skips comment-only blocks", async () => {
    const events = await collectEvents([":comment\n\ndata: real\n\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("real");
  });

  test("concatenates multi-line data", async () => {
    const events = await collectEvents(["data: line1\ndata: line2\ndata: line3\n\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("line1\nline2\nline3");
  });

  test("handles chunk boundaries mid-field", async () => {
    // "data: hel" in chunk 1, "lo\n\n" in chunk 2
    const events = await collectEvents(["data: hel", "lo\n\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("hello");
  });

  test("handles chunk boundary mid-event", async () => {
    const events = await collectEvents(["id: 1\n", "data: body\n\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("1");
    expect(events[0]?.data).toBe("body");
  });

  test("strips single leading space from field value", async () => {
    const events = await collectEvents(["data:no-space\n\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("no-space");
  });

  test("preserves data with extra spaces", async () => {
    const events = await collectEvents(["data:  two-spaces\n\n"]);
    expect(events).toHaveLength(1);
    // First space is stripped per spec, second is preserved
    expect(events[0]?.data).toBe(" two-spaces");
  });

  test("handles field with no colon (empty value)", async () => {
    const events = await collectEvents(["data\n\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("");
  });

  test("flushes final event when stream ends without trailing newline", async () => {
    const events = await collectEvents(["data: final"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("final");
  });

  test("handles empty stream", async () => {
    const events = await collectEvents([]);
    expect(events).toHaveLength(0);
  });

  test("omits undefined fields from yielded event", async () => {
    const events = await collectEvents(["data: simple\n\n"]);
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error("expected event");
    expect("id" in event).toBe(false);
    expect("event" in event).toBe(false);
    expect("retry" in event).toBe(false);
  });
});
