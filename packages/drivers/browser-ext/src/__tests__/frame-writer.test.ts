import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { createFrameWriter, MAX_FRAME_SIZE } from "../native-host/frame-writer.js";

describe("createFrameWriter", () => {
  test("writes a single frame with correct 4-byte LE length prefix", async () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on("data", (c) => chunks.push(c as Buffer));
    const writer = createFrameWriter(sink);

    const payload = '{"kind":"pong","seq":7}';
    await writer.write(payload);
    writer.close();
    await new Promise<void>((resolve) => sink.on("end", () => resolve()));

    const combined = Buffer.concat(chunks.map((c) => new Uint8Array(c)));
    expect(combined.length).toBe(4 + payload.length);
    expect(combined.readUInt32LE(0)).toBe(payload.length);
    expect(combined.subarray(4).toString("utf-8")).toBe(payload);
  });

  test("serializes multiple frames with individual prefixes", async () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on("data", (c) => chunks.push(c as Buffer));
    const writer = createFrameWriter(sink);

    await writer.write('{"a":1}');
    await writer.write('{"b":2}');
    writer.close();
    await new Promise<void>((resolve) => sink.on("end", () => resolve()));

    const combined = Buffer.concat(chunks.map((c) => new Uint8Array(c)));
    expect(combined.readUInt32LE(0)).toBe(7);
    expect(combined.subarray(4, 11).toString("utf-8")).toBe('{"a":1}');
    expect(combined.readUInt32LE(11)).toBe(7);
    expect(combined.subarray(15, 22).toString("utf-8")).toBe('{"b":2}');
  });

  test("rejects payloads exceeding MAX_FRAME_SIZE", async () => {
    const sink = new PassThrough();
    const writer = createFrameWriter(sink);
    const oversized = "x".repeat(MAX_FRAME_SIZE + 1);
    await expect(writer.write(oversized)).rejects.toThrow(/max frame size/i);
  });

  test("rejects write after close", async () => {
    const sink = new PassThrough();
    const writer = createFrameWriter(sink);
    writer.close();
    await expect(writer.write('{"a":1}')).rejects.toThrow(/closed/i);
  });
});
