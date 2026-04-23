import { describe, expect, test } from "bun:test";

import { createChunkBuffer } from "../native-host/chunk-reassembly.js";
import type { NmFrame } from "../native-host/nm-frame.js";

type Chunk = Extract<NmFrame, { kind: "chunk" }>;

/**
 * Matches the real extension sender: encode the WHOLE payload to base64 first,
 * then slice that base64 string into arbitrary chunks. NOT the same as encoding
 * each utf-8 fragment independently, which would only work on 4-char-aligned
 * cuts and silently corrupt most payloads.
 */
function chunkBase64WireFormat(payload: string, boundaries: readonly number[]): string[] {
  const full = Buffer.from(payload, "utf-8").toString("base64");
  const parts: string[] = [];
  let prev = 0;
  for (const boundary of boundaries) {
    parts.push(full.slice(prev, boundary));
    prev = boundary;
  }
  parts.push(full.slice(prev));
  return parts;
}

describe("chunk-reassembly", () => {
  test("reassembles three chunks into a cdp_result frame (wire-format)", () => {
    const frames: NmFrame[] = [];
    const buf = createChunkBuffer({
      events: {
        onFrameReady: (f) => frames.push(f),
        onTimeout: () => {},
        onGroupDrop: () => {},
      },
    });
    const payload = JSON.stringify({
      kind: "cdp_result",
      sessionId: "22222222-2222-4222-8222-222222222222",
      id: 1,
      result: { x: 1 },
    });
    // Use NON-4-char-aligned boundaries to verify the reassembler joins
    // base64 strings before decoding (rather than decoding each piece).
    const encoded = chunkBase64WireFormat(payload, [13, 37]);
    expect(encoded.length).toBe(3);
    for (let i = 0; i < encoded.length; i++) {
      const data = encoded[i];
      if (data === undefined) continue;
      const chunk: Chunk = {
        kind: "chunk",
        sessionId: "22222222-2222-4222-8222-222222222222",
        correlationId: "r:1",
        payloadKind: "result_value",
        index: i,
        total: 3,
        data,
      };
      buf.add(chunk);
    }
    expect(frames.length).toBe(1);
    expect(frames[0]?.kind).toBe("cdp_result");
  });

  test("mismatched payloadKind drops group", () => {
    const drops: { reason: string }[] = [];
    const buf = createChunkBuffer({
      events: {
        onFrameReady: () => {},
        onTimeout: () => {},
        onGroupDrop: (i) => drops.push({ reason: i.reason }),
      },
    });
    buf.add({
      kind: "chunk",
      sessionId: "22222222-2222-4222-8222-222222222222",
      correlationId: "r:1",
      payloadKind: "result_value",
      index: 0,
      total: 2,
      data: "aA==",
    });
    buf.add({
      kind: "chunk",
      sessionId: "22222222-2222-4222-8222-222222222222",
      correlationId: "r:1",
      payloadKind: "event_frame",
      index: 1,
      total: 2,
      data: "aA==",
    });
    expect(drops[0]?.reason).toBe("mismatched_payload_kind");
  });

  test("two sessions disambiguated by sessionId", () => {
    const frames: NmFrame[] = [];
    const buf = createChunkBuffer({
      events: {
        onFrameReady: (f) => frames.push(f),
        onTimeout: () => {},
        onGroupDrop: () => {},
      },
    });
    const payload = JSON.stringify({
      kind: "cdp_result",
      sessionId: "22222222-2222-4222-8222-222222222222",
      id: 1,
      result: {},
    });
    const data = Buffer.from(payload, "utf-8").toString("base64");
    buf.add({
      kind: "chunk",
      sessionId: "22222222-2222-4222-8222-222222222222",
      correlationId: "r:1",
      payloadKind: "result_value",
      index: 0,
      total: 1,
      data,
    });
    const payload2 = JSON.stringify({
      kind: "cdp_result",
      sessionId: "33333333-3333-4333-8333-333333333333",
      id: 1,
      result: {},
    });
    buf.add({
      kind: "chunk",
      sessionId: "33333333-3333-4333-8333-333333333333",
      correlationId: "r:1",
      payloadKind: "result_value",
      index: 0,
      total: 1,
      data: Buffer.from(payload2, "utf-8").toString("base64"),
    });
    expect(frames.length).toBe(2);
  });

  test("partial buffer + timeout fires callback", () => {
    const timeouts: { correlationId: string }[] = [];
    const buf = createChunkBuffer({
      timeoutMs: 100,
      events: {
        onFrameReady: () => {},
        onTimeout: (i) => timeouts.push({ correlationId: i.correlationId }),
        onGroupDrop: () => {},
      },
    });
    buf.add({
      kind: "chunk",
      sessionId: "22222222-2222-4222-8222-222222222222",
      correlationId: "r:slow",
      payloadKind: "result_value",
      index: 0,
      total: 3,
      data: "aA==",
    });
    buf.tick(Date.now() + 200);
    expect(timeouts[0]?.correlationId).toBe("r:slow");
  });
});
