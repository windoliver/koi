import { describe, expect, test } from "bun:test";
import { computeNgramKey, extractNgrams, extractToolSequences } from "./ngram.js";
import { createTrace } from "./test-helpers.js";
import type { ToolStep } from "./types.js";

function turn(
  turnIndex: number,
  ids: readonly string[],
): {
  readonly turnIndex: number;
  readonly steps: readonly ToolStep[];
} {
  return { turnIndex, steps: ids.map((toolId) => ({ toolId })) };
}

describe("computeNgramKey", () => {
  test("pipe-joins tool IDs", () => {
    expect(computeNgramKey([{ toolId: "a" }, { toolId: "b" }, { toolId: "c" }])).toBe("a|b|c");
  });
});

describe("extractToolSequences", () => {
  test("projects tool_call events in order, preserving real turnIndex", () => {
    const seqs = extractToolSequences([createTrace(7, ["read", "parse", "save"])]);
    expect(seqs).toHaveLength(1);
    expect(seqs[0]?.turnIndex).toBe(7);
    expect(seqs[0]?.steps.map((s) => s.toolId)).toEqual(["read", "parse", "save"]);
  });

  test("yields no outcome signal when output is undefined (no capture)", () => {
    const seqs = extractToolSequences([createTrace(0, ["broken"], [undefined])]);
    expect(seqs[0]?.steps[0]?.outcome).toBeUndefined();
  });

  test("yields no outcome signal for plain object with `error` field (not a kind:error envelope)", () => {
    const seqs = extractToolSequences([createTrace(0, ["broken"], [{ error: "boom" }])]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("success");
  });

  test("classifies kind:error envelopes as failure", () => {
    const seqs = extractToolSequences([createTrace(0, ["x"], [{ kind: "error", message: "x" }])]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("failure");
  });

  test("classifies kind:denied envelopes as failure", () => {
    const seqs = extractToolSequences([createTrace(0, ["x"], [{ kind: "denied" }])]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("failure");
  });

  test("treats null output as no outcome (not failure)", () => {
    const seqs = extractToolSequences([createTrace(0, ["void_tool"], [null])]);
    expect(seqs[0]?.steps[0]?.outcome).toBeUndefined();
  });

  test("treats validation rejects (kind:validation, error code) as success, not failure", () => {
    const seqs = extractToolSequences([
      createTrace(0, ["v"], [{ kind: "validation", error: "bad input", code: "VALIDATION" }]),
    ]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("success");
  });
});

describe("extractNgrams", () => {
  test("emits sliding-window n-grams of size [min..max]", () => {
    const map = extractNgrams([turn(0, ["a", "b", "c"])], 2, 3);
    expect(map.get("a|b")).toBeDefined();
    expect(map.get("b|c")).toBeDefined();
    expect(map.get("a|b|c")).toBeDefined();
    expect(map.get("a|b|c|d")).toBeUndefined();
  });

  test("counts a turn once per key even when pattern repeats within turn", () => {
    const map = extractNgrams([turn(0, ["a", "b", "a", "b"])], 2, 2);
    expect(map.get("a|b")?.turnIndices).toEqual([0]);
  });

  test("aggregates same n-gram across multiple turns", () => {
    const map = extractNgrams(
      [turn(0, ["a", "b"]), turn(1, ["a", "b"]), turn(2, ["a", "b"])],
      2,
      2,
    );
    expect(map.get("a|b")?.turnIndices).toEqual([0, 1, 2]);
  });

  test("preserves real (non-zero, non-contiguous) turn indices from the source traces", () => {
    const map = extractNgrams(
      [turn(10, ["a", "b"]), turn(42, ["a", "b"]), turn(100, ["a", "b"])],
      2,
      2,
    );
    expect(map.get("a|b")?.turnIndices).toEqual([10, 42, 100]);
  });

  test("empty sequence contributes no n-grams", () => {
    const map = extractNgrams([turn(0, [])], 2, 3);
    expect(map.size).toBe(0);
  });
});
