import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";

import { createFrameReader, MAX_FRAME_SIZE } from "../native-host/frame-reader.js";

function framed(payload: string): Buffer {
  const body = Buffer.from(payload, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.byteLength, 0);
  return Buffer.concat([new Uint8Array(header), new Uint8Array(body)]);
}

async function* iterateFrames(chunks: readonly Buffer[]): AsyncGenerator<string> {
  const stream = Readable.from(chunks);
  const reader = createFrameReader(stream);
  for await (const frame of reader) {
    yield frame;
  }
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const f of gen) out.push(f);
  return out;
}

describe("createFrameReader", () => {
  test("reads a single framed message", async () => {
    const frames = await collect(iterateFrames([framed('{"kind":"ping","seq":1}')]));
    expect(frames).toEqual(['{"kind":"ping","seq":1}']);
  });

  test("reads multiple framed messages in one chunk", async () => {
    const combined = Buffer.concat([
      new Uint8Array(framed('{"a":1}')),
      new Uint8Array(framed('{"b":2}')),
    ]);
    const frames = await collect(iterateFrames([combined]));
    expect(frames).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("reassembles frames split across chunk boundaries", async () => {
    const whole = framed('{"kind":"attach","tabId":42}');
    const chunks = [whole.subarray(0, 2), whole.subarray(2, 5), whole.subarray(5)];
    const frames = await collect(iterateFrames(chunks));
    expect(frames).toEqual(['{"kind":"attach","tabId":42}']);
  });

  test("terminates on end-of-stream with no pending frame", async () => {
    const frames = await collect(iterateFrames([]));
    expect(frames).toEqual([]);
  });

  test("rejects frames larger than MAX_FRAME_SIZE", async () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_FRAME_SIZE + 1, 0);
    const stream = Readable.from([header]);
    await expect(
      (async () => {
        const reader = createFrameReader(stream);
        for await (const _ of reader) {
          void _;
        }
      })(),
    ).rejects.toThrow(/max frame size/i);
  });

  test("rejects zero-length frames as protocol violation", async () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(0, 0);
    const stream = Readable.from([header]);
    await expect(
      (async () => {
        const reader = createFrameReader(stream);
        for await (const _ of reader) {
          void _;
        }
      })(),
    ).rejects.toThrow(/zero-length/i);
  });

  test("rejects truncated stream (partial body)", async () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(10, 0);
    const partial = Buffer.from("abc", "utf-8");
    const stream = Readable.from([
      Buffer.concat([new Uint8Array(header), new Uint8Array(partial)]),
    ]);
    await expect(
      (async () => {
        const reader = createFrameReader(stream);
        for await (const _ of reader) {
          void _;
        }
      })(),
    ).rejects.toThrow(/truncated/i);
  });
});
