import { describe, expect, test } from "bun:test";
import type { ModelResponse } from "@koi/core";
import { reassembleResponses, SEGMENT_SEPARATOR } from "./reassemble.js";

function part(content: string, overrides: Partial<ModelResponse> = {}): ModelResponse {
  return { content, model: "gpt-x", ...overrides };
}

describe("reassembleResponses", () => {
  test("throws on empty input", () => {
    expect(() => reassembleResponses([])).toThrow();
  });

  test("returns the only response unchanged when one part is given", () => {
    const only = part("hi");
    expect(reassembleResponses([only])).toBe(only);
  });

  test("concatenates content in the input order", () => {
    const out = reassembleResponses([part("first"), part("second"), part("third")]);
    expect(out.content).toBe(`first${SEGMENT_SEPARATOR}second${SEGMENT_SEPARATOR}third`);
  });

  test("retains the first response's model and responseId", () => {
    const out = reassembleResponses([
      part("a", { model: "first-model", responseId: "id-a" }),
      part("b", { model: "second-model", responseId: "id-b" }),
    ]);
    expect(out.model).toBe("first-model");
    expect(out.responseId).toBe("id-a");
  });

  test("surfaces the strongest non-success stopReason rather than the last", () => {
    // Concatenation would mask truncation if reassembly only honored the
    // last segment's reason. The synthetic stopReason must reflect any
    // segment that did NOT complete normally.
    const out = reassembleResponses([
      part("a", { stopReason: "tool_use" }),
      part("b", { stopReason: "stop" }),
    ]);
    expect(out.stopReason).toBe("tool_use");
  });

  test("falls back to the last stopReason when every segment finished normally", () => {
    const out = reassembleResponses([
      part("a", { stopReason: "stop" }),
      part("b", { stopReason: "stop" }),
    ]);
    expect(out.stopReason).toBe("stop");
  });

  test("preserves per-segment provenance under metadata.rlmSegments", () => {
    const out = reassembleResponses([
      part("a", { model: "m1", responseId: "r-a", stopReason: "stop" }),
      part("b", { model: "m2", responseId: "r-b" }),
    ]);
    const segments = out.metadata?.rlmSegments;
    expect(Array.isArray(segments)).toBe(true);
    if (!Array.isArray(segments)) throw new Error("expected array");
    expect(segments).toEqual([
      { index: 0, model: "m1", stopReason: "stop", responseId: "r-a" },
      { index: 1, model: "m2", responseId: "r-b" },
    ]);
  });

  test("preserves caller metadata alongside rlmSegments", () => {
    const out = reassembleResponses([
      part("a", { metadata: { callerKey: "v1" } }),
      part("b", { metadata: { callerKey: "v2" } }),
    ]);
    expect(out.metadata?.callerKey).toBe("v1");
    expect(out.metadata?.rlmSegments).toBeDefined();
  });

  test("sums usage across parts and aggregates cache fields when present", () => {
    const out = reassembleResponses([
      part("a", {
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 2,
        },
      }),
      part("b", {
        usage: {
          inputTokens: 7,
          outputTokens: 3,
          cacheWriteTokens: 4,
        },
      }),
    ]);
    expect(out.usage).toEqual({
      inputTokens: 17,
      outputTokens: 8,
      cacheReadTokens: 2,
      cacheWriteTokens: 4,
    });
  });

  test("omits usage when no part has usage data", () => {
    const out = reassembleResponses([part("a"), part("b")]);
    expect(out.usage).toBeUndefined();
  });

  test("rebuilds richContent so plain-content segments are not dropped on the stream path", () => {
    // The engine's synthesized modelStream path replays richContent and
    // ignores content when richContent is set. A partial richContent would
    // silently drop the text of the middle segment from any stream
    // consumer. Reassembly therefore reconstructs the full ordered view,
    // synthesizing a text block for content-only segments and inserting
    // text separators that mirror the content join.
    const out = reassembleResponses([
      part("a", { richContent: [{ kind: "text", text: "x" }] }),
      part("middle"),
      part("c", { richContent: [{ kind: "text", text: "y" }] }),
    ]);
    expect(out.richContent).toEqual([
      { kind: "text", text: "x" },
      { kind: "text", text: "\n\n" },
      { kind: "text", text: "middle" },
      { kind: "text", text: "\n\n" },
      { kind: "text", text: "y" },
    ]);
  });

  test("omits richContent when no part carries it (stream path falls back to content)", () => {
    const out = reassembleResponses([part("a"), part("b")]);
    expect(out.richContent).toBeUndefined();
  });
});
