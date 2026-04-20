import type { Writable } from "node:stream";

export const MAX_FRAME_SIZE: number = 1024 * 1024;

export interface FrameWriter {
  readonly write: (payload: string) => Promise<void>;
  readonly close: () => void;
}

export function createFrameWriter(sink: Writable): FrameWriter {
  let closed = false;
  return {
    async write(payload: string): Promise<void> {
      if (closed) throw new Error("Frame writer: closed");
      const body = Buffer.from(payload, "utf-8");
      if (body.byteLength > MAX_FRAME_SIZE) {
        throw new Error(
          `Frame writer: payload of ${body.byteLength} bytes exceeds max frame size ${MAX_FRAME_SIZE}`,
        );
      }
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.byteLength, 0);
      const combined = Buffer.concat([new Uint8Array(header), new Uint8Array(body)]);
      if (!sink.write(combined)) {
        await new Promise<void>((resolve) => sink.once("drain", () => resolve()));
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      sink.end();
    },
  };
}
