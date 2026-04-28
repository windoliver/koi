import { describe, expect, test } from "bun:test";
import type { NmFrame } from "../../../src/native-host/nm-frame.js";
import { createChunkReceiver, createChunkSender } from "../chunking.js";

describe("extension chunking", () => {
  test("splits oversized results and reassembles them", () => {
    const emitted: NmFrame[] = [];
    const sender = createChunkSender((frame) => emitted.push(frame), {
      frameThresholdBytes: 8,
      chunkBytes: 12,
    });

    sender.sendResult({
      kind: "cdp_result",
      sessionId: "11111111-1111-4111-8111-111111111111",
      id: 7,
      result: { value: "x".repeat(64) },
    });

    expect(emitted.every((frame) => frame.kind === "chunk")).toBe(true);

    let reassembled: NmFrame | null = null;
    const receiver = createChunkReceiver((frame) => {
      reassembled = frame;
    });
    for (const frame of emitted) receiver.addChunk(frame as Extract<NmFrame, { kind: "chunk" }>);
    if (reassembled === null) throw new Error("chunk reassembly did not emit a frame");
    expect(JSON.stringify(reassembled)).toBe(
      JSON.stringify({
        kind: "cdp_result",
        sessionId: "11111111-1111-4111-8111-111111111111",
        id: 7,
        result: { value: "x".repeat(64) },
      }),
    );
  });
});
