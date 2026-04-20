import type { Readable } from "node:stream";

export const MAX_FRAME_SIZE: number = 1024 * 1024; // 1 MB per Chrome's NM spec

/**
 * Reads length-prefixed frames from a stream. Each frame = 4-byte LE length +
 * `length` bytes of UTF-8 JSON. Yields decoded JSON strings.
 *
 * Rejects: zero-length frames (protocol violation), frames > MAX_FRAME_SIZE,
 * truncated streams (buffered bytes remaining when stream ends).
 */
export async function* createFrameReader(stream: Readable): AsyncGenerator<string> {
  let buffer: Buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    const next = chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array);
    buffer = Buffer.concat([new Uint8Array(buffer), new Uint8Array(next)]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length === 0) {
        throw new Error("Frame reader: zero-length frame is a protocol violation");
      }
      if (length > MAX_FRAME_SIZE) {
        throw new Error(
          `Frame reader: frame of ${length} bytes exceeds max frame size ${MAX_FRAME_SIZE}`,
        );
      }
      if (buffer.length < 4 + length) {
        break;
      }
      const bodyStart = 4;
      const bodyEnd = 4 + length;
      const body = buffer.subarray(bodyStart, bodyEnd);
      buffer = buffer.subarray(bodyEnd);
      yield body.toString("utf-8");
    }
  }
  if (buffer.length > 0) {
    throw new Error(
      `Frame reader: stream ended with ${buffer.length} unread bytes (truncated frame)`,
    );
  }
}
