import { describe, expect, test } from "bun:test";
import {
  createLineReader,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
} from "./line-reader.js";

/** Helper: create a ReadableStream from an array of string chunks. */
function streamFrom(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const encoded = chunks.map((c) => encoder.encode(c));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of encoded) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/** Helper: collect all lines from an async generator. */
async function collectLines(
  stream: ReadableStream<Uint8Array>,
  options?: { readonly maxLineBytes?: number; readonly maxTotalBytes?: number },
): Promise<readonly string[]> {
  const lines: string[] = [];
  for await (const line of createLineReader(stream, options)) {
    lines.push(line);
  }
  return lines;
}

describe("createLineReader", () => {
  test("yields complete lines split on newline", async () => {
    const lines = await collectLines(streamFrom(["hello\nworld\n"]));
    expect(lines).toEqual(["hello", "world"]);
  });

  test("handles chunks split across line boundaries", async () => {
    const lines = await collectLines(streamFrom(["hel", "lo\nwor", "ld\n"]));
    expect(lines).toEqual(["hello", "world"]);
  });

  test("flushes trailing partial line on stream end", async () => {
    const lines = await collectLines(streamFrom(["hello\nworld"]));
    expect(lines).toEqual(["hello", "world"]);
  });

  test("strips \\r from \\r\\n line endings", async () => {
    const lines = await collectLines(streamFrom(["hello\r\nworld\r\n"]));
    expect(lines).toEqual(["hello", "world"]);
  });

  test("strips \\r from trailing partial line", async () => {
    const lines = await collectLines(streamFrom(["hello\r"]));
    expect(lines).toEqual(["hello"]);
  });

  test("handles empty lines", async () => {
    const lines = await collectLines(streamFrom(["a\n\nb\n"]));
    expect(lines).toEqual(["a", "", "b"]);
  });

  test("yields nothing for empty stream", async () => {
    const lines = await collectLines(streamFrom([]));
    expect(lines).toEqual([]);
  });

  test("yields nothing for stream with only empty string", async () => {
    const lines = await collectLines(streamFrom([""]));
    expect(lines).toEqual([]);
  });

  test("truncates lines exceeding maxLineBytes", async () => {
    const longLine = "x".repeat(100);
    const lines = await collectLines(streamFrom([`${longLine}\nshort\n`]), {
      maxLineBytes: 10,
    });
    expect(lines[0]).toBe("x".repeat(10));
    expect(lines[1]).toBe("short");
  });

  test("truncates buffer eagerly when no newline and exceeds maxLineBytes", async () => {
    // Send a single chunk with no newline, exceeding maxLineBytes
    const longChunk = "y".repeat(50);
    const lines = await collectLines(streamFrom([longChunk]), {
      maxLineBytes: 20,
    });
    // Flushed partial line should be truncated to maxLineBytes
    expect(lines).toEqual(["y".repeat(20)]);
  });

  test("stops yielding after maxTotalBytes", async () => {
    const lines = await collectLines(streamFrom(["aaaa\nbbbb\ncccc\ndddd\n"]), {
      maxTotalBytes: 10,
    });
    // "aaaa" = 4 bytes, "bbbb" = 4 bytes (total 8), "cccc" would push to 12 > 10
    expect(lines).toEqual(["aaaa", "bbbb"]);
  });

  test("stops at exact maxTotalBytes boundary", async () => {
    const lines = await collectLines(streamFrom(["ab\ncd\n"]), {
      maxTotalBytes: 4,
    });
    // "ab" = 2 bytes, "cd" = 2 bytes → total 4, exactly at limit
    expect(lines).toEqual(["ab", "cd"]);
  });

  test("handles multiple chunks forming a single line", async () => {
    const lines = await collectLines(streamFrom(["a", "b", "c", "\n"]));
    expect(lines).toEqual(["abc"]);
  });

  test("exports correct default constants", () => {
    expect(DEFAULT_MAX_LINE_BYTES).toBe(1 * 1024 * 1024);
    expect(DEFAULT_MAX_TOTAL_BYTES).toBe(10 * 1024 * 1024);
  });
});
