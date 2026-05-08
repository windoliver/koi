import { describe, expect, test } from "bun:test";
import {
  createLineReader,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  type LineReaderOptions,
} from "./line-reader.js";

function streamFromByteChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function streamFromStrings(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return streamFromByteChunks(chunks.map((chunk) => encoder.encode(chunk)));
}

async function collectLines(
  stream: ReadableStream<Uint8Array>,
  options?: LineReaderOptions,
): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of createLineReader(stream, options)) {
    lines.push(line);
  }
  return lines;
}

describe("createLineReader", () => {
  test("exports the documented defaults", () => {
    expect(DEFAULT_MAX_LINE_BYTES).toBe(1 * 1024 * 1024);
    expect(DEFAULT_MAX_TOTAL_BYTES).toBe(10 * 1024 * 1024);
  });

  test("reconstructs newline-delimited records across chunk boundaries", async () => {
    const lines = await collectLines(streamFromStrings(['{"a":1', '}\n{"b"', ':2}\n']));

    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("yields a truncated prefix for oversized lines, then resumes after the newline", async () => {
    const lines = await collectLines(streamFromStrings(["abcdefgh", "ijk\nok\n"]), {
      maxLineBytes: 4,
    });

    expect(lines).toEqual(["abcd", "ok"]);
  });

  test("enforces maxTotalBytes even for the trailing eof line", async () => {
    const lines = await collectLines(streamFromStrings(["hello"]), {
      maxTotalBytes: 3,
    });

    expect(lines).toEqual(["hel"]);
  });

  test("keeps decoder state isolated per reader", async () => {
    const encoder = new TextEncoder();
    const emojiBytes = encoder.encode("😀\n");
    const firstHalf = emojiBytes.slice(0, 2);
    const secondHalf = emojiBytes.slice(2);

    const first = await collectLines(streamFromByteChunks([firstHalf, secondHalf]));
    const second = await collectLines(streamFromByteChunks([firstHalf, secondHalf]));

    expect(first).toEqual(["😀"]);
    expect(second).toEqual(["😀"]);
  });
});
