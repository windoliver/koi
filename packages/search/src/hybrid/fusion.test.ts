import { describe, expect, test } from "bun:test";
import type { SearchResult } from "@koi/core";
import { applyFusion, applyLinear, applyRrf, applyWeightedRrf } from "./fusion.js";

function makeResult(id: string, score: number, source: string): SearchResult {
  return { id, score, content: `content-${id}`, metadata: {}, source };
}

describe("applyRrf", () => {
  test("RRF with 2 lists, 3 items each — hand-computed scores", () => {
    const k = 60;
    const list1 = [
      makeResult("a", 0.9, "bm25"),
      makeResult("b", 0.7, "bm25"),
      makeResult("c", 0.5, "bm25"),
    ];
    const list2 = [
      makeResult("b", 0.8, "vec"),
      makeResult("a", 0.6, "vec"),
      makeResult("d", 0.4, "vec"),
    ];

    const results = applyRrf([list1, list2], k, 10);

    // a: 1/(60+1) + 1/(60+2) = 1/61 + 1/62
    const scoreA = 1 / 61 + 1 / 62;
    // b: 1/(60+2) + 1/(60+1) = 1/62 + 1/61
    const scoreB = 1 / 62 + 1 / 61;
    // c: 1/(60+3)
    const scoreC = 1 / 63;
    // d: 1/(60+3)
    const scoreD = 1 / 63;

    // a and b have equal RRF scores (same formula, symmetric)
    expect(results[0]?.score).toBeCloseTo(scoreA, 10);
    expect(results[1]?.score).toBeCloseTo(scoreB, 10);
    expect(scoreA).toBeCloseTo(scoreB, 10);
    expect(results[2]?.score).toBeCloseTo(scoreC, 10);
    expect(results[3]?.score).toBeCloseTo(scoreD, 10);
  });

  test("RRF with disjoint results — all items appear", () => {
    const list1 = [makeResult("a", 0.9, "s1"), makeResult("b", 0.8, "s1")];
    const list2 = [makeResult("c", 0.7, "s2"), makeResult("d", 0.6, "s2")];

    const results = applyRrf([list1, list2], 60, 10);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
    expect(ids).toContain("d");
  });

  test("RRF with fully overlapping results — scores are sum", () => {
    const list1 = [makeResult("a", 0.9, "s1"), makeResult("b", 0.8, "s1")];
    const list2 = [makeResult("a", 0.9, "s2"), makeResult("b", 0.8, "s2")];

    const results = applyRrf([list1, list2], 60, 10);
    // a: 1/61 + 1/61 = 2/61
    expect(results[0]?.id).toBe("a");
    expect(results[0]?.score).toBeCloseTo(2 / 61, 10);
  });

  test("RRF with empty list — results from other retriever only", () => {
    const list1 = [makeResult("a", 0.9, "s1")];
    const list2: SearchResult[] = [];

    const results = applyRrf([list1, list2], 60, 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("a");
    expect(results[0]?.score).toBeCloseTo(1 / 61, 10);
  });

  test("single retriever — passthrough with RRF scoring", () => {
    const list = [makeResult("a", 0.9, "s1"), makeResult("b", 0.8, "s1")];
    const results = applyRrf([list], 60, 10);
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe("a");
  });

  test("limit is respected", () => {
    const list1 = [
      makeResult("a", 0.9, "s1"),
      makeResult("b", 0.8, "s1"),
      makeResult("c", 0.7, "s1"),
    ];
    const results = applyRrf([list1], 60, 2);
    expect(results).toHaveLength(2);
  });
});

describe("applyWeightedRrf", () => {
  test("weighted RRF with unequal weights — higher weight dominates", () => {
    const list1 = [makeResult("a", 0.9, "bm25"), makeResult("b", 0.7, "bm25")];
    const list2 = [makeResult("b", 0.8, "vec"), makeResult("a", 0.6, "vec")];

    const results = applyWeightedRrf([list1, list2], 60, [0.7, 0.3], 10);

    // a: 0.7/61 + 0.3/62
    const scoreA = 0.7 / 61 + 0.3 / 62;
    // b: 0.7/62 + 0.3/61
    const scoreB = 0.7 / 62 + 0.3 / 61;

    // a should rank higher because it's rank 1 in the list with higher weight
    expect(results[0]?.id).toBe("a");
    expect(results[0]?.score).toBeCloseTo(scoreA, 10);
    expect(results[1]?.score).toBeCloseTo(scoreB, 10);
  });
});

describe("applyLinear", () => {
  test("linear with min-max — hand-computed weighted combination", () => {
    // list1 scores: [0.9, 0.5] → min-max normalized: [1.0, 0.0]
    // list2 scores: [0.8, 0.4] → min-max normalized: [1.0, 0.0]
    const list1 = [makeResult("a", 0.9, "s1"), makeResult("b", 0.5, "s1")];
    const list2 = [makeResult("a", 0.8, "s2"), makeResult("c", 0.4, "s2")];

    const results = applyLinear([list1, list2], [0.6, 0.4], "min_max", 10);

    // a: 0.6 * 1.0 + 0.4 * 1.0 = 1.0
    expect(results[0]?.id).toBe("a");
    expect(results[0]?.score).toBeCloseTo(1.0, 5);

    // b: 0.6 * 0.0 = 0.0
    // c: 0.4 * 0.0 = 0.0
    // Both should have score 0
    const lowScores = results.filter((r) => r.id !== "a");
    for (const r of lowScores) {
      expect(r.score).toBeCloseTo(0, 5);
    }
  });

  test("linear with single item lists — no normalization effect", () => {
    const list1 = [makeResult("a", 0.7, "s1")];
    const list2 = [makeResult("b", 0.5, "s2")];

    const results = applyLinear([list1, list2], [0.6, 0.4], "min_max", 10);
    // Single-item min-max → all 1.0
    expect(results).toHaveLength(2);
  });
});

describe("applyFusion dispatcher", () => {
  test("dispatches rrf", () => {
    const list = [makeResult("a", 0.9, "s1")];
    const results = applyFusion({ kind: "rrf" }, [list], 10);
    expect(results).toHaveLength(1);
  });

  test("dispatches weighted_rrf", () => {
    const list = [makeResult("a", 0.9, "s1")];
    const results = applyFusion({ kind: "weighted_rrf", weights: [1] }, [list], 10);
    expect(results).toHaveLength(1);
  });

  test("dispatches linear", () => {
    const list = [makeResult("a", 0.9, "s1")];
    const results = applyFusion({ kind: "linear", weights: [1] }, [list], 10);
    expect(results).toHaveLength(1);
  });

  test("dispatches custom fusion function", () => {
    const list = [makeResult("a", 0.9, "s1")];
    const customFn = (lists: readonly (readonly SearchResult[])[], limit: number) => {
      return lists.flat().slice(0, limit);
    };
    const results = applyFusion({ kind: "custom", fuse: customFn }, [list], 10);
    expect(results).toHaveLength(1);
  });
});
