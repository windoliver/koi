import { describe, expect, test } from "bun:test";
import { computeNgramKey, extractNgrams, extractToolSequences } from "./ngram.js";
import { createTrace } from "./test-helpers.js";

describe("computeNgramKey", () => {
  test("pipe-joins tool IDs", () => {
    expect(computeNgramKey([{ toolId: "a" }, { toolId: "b" }, { toolId: "c" }])).toBe("a|b|c");
  });
});

describe("extractToolSequences", () => {
  test("projects tool_call events in order", () => {
    const seqs = extractToolSequences([createTrace(0, ["read", "parse", "save"])]);
    expect(seqs).toHaveLength(1);
    expect(seqs[0]?.map((s) => s.toolId)).toEqual(["read", "parse", "save"]);
  });

  test("infers failure when output is undefined", () => {
    const seqs = extractToolSequences([createTrace(0, ["broken"], [undefined])]);
    expect(seqs[0]?.[0]?.outcome).toBe("failure");
  });

  test("infers failure when output has truthy error field", () => {
    const seqs = extractToolSequences([createTrace(0, ["broken"], [{ error: "boom" }])]);
    expect(seqs[0]?.[0]?.outcome).toBe("failure");
  });

  test("treats null output as success", () => {
    const seqs = extractToolSequences([createTrace(0, ["void_tool"], [null])]);
    expect(seqs[0]?.[0]?.outcome).toBe("success");
  });
});

describe("extractNgrams", () => {
  test("emits sliding-window n-grams of size [min..max]", () => {
    const map = extractNgrams([[{ toolId: "a" }, { toolId: "b" }, { toolId: "c" }]], 2, 3);
    expect(map.get("a|b")).toBeDefined();
    expect(map.get("b|c")).toBeDefined();
    expect(map.get("a|b|c")).toBeDefined();
    expect(map.get("a|b|c|d")).toBeUndefined();
  });

  test("counts a turn once per key even when pattern repeats within turn", () => {
    const seq = [{ toolId: "a" }, { toolId: "b" }, { toolId: "a" }, { toolId: "b" }];
    const map = extractNgrams([seq], 2, 2);
    // "a|b" appears twice within turn 0 — must dedupe to one occurrence
    expect(map.get("a|b")?.turnIndices).toEqual([0]);
  });

  test("aggregates same n-gram across multiple turns", () => {
    const seqs = [
      [{ toolId: "a" }, { toolId: "b" }],
      [{ toolId: "a" }, { toolId: "b" }],
      [{ toolId: "a" }, { toolId: "b" }],
    ];
    const map = extractNgrams(seqs, 2, 2);
    expect(map.get("a|b")?.turnIndices).toEqual([0, 1, 2]);
  });

  test("empty sequence contributes no n-grams", () => {
    const map = extractNgrams([[]], 2, 3);
    expect(map.size).toBe(0);
  });
});
