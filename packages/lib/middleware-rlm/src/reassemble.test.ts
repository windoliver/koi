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

  test("uses the last response's stopReason", () => {
    const out = reassembleResponses([
      part("a", { stopReason: "tool_use" }),
      part("b", { stopReason: "stop" }),
    ]);
    expect(out.stopReason).toBe("stop");
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

  test("concatenates richContent when any part has it", () => {
    const out = reassembleResponses([
      part("a", { richContent: [{ kind: "text", text: "x" }] }),
      part("b"),
      part("c", { richContent: [{ kind: "text", text: "y" }] }),
    ]);
    expect(out.richContent).toEqual([
      { kind: "text", text: "x" },
      { kind: "text", text: "y" },
    ]);
  });
});
