import { describe, expect, test } from "bun:test";
import { expandCausalGraph } from "./graph-walk.js";
import type { MemoryFact } from "./types.js";

function makeFact(overrides: Partial<MemoryFact> & { readonly id: string }): MemoryFact {
  return {
    fact: `fact ${overrides.id}`,
    category: "context",
    timestamp: new Date().toISOString(),
    status: "active",
    supersededBy: null,
    relatedEntities: [],
    lastAccessed: new Date().toISOString(),
    accessCount: 0,
    ...overrides,
  };
}

describe("expandCausalGraph", () => {
  test("linear chain: A→B→C, expand from C, maxHops=2 finds A and B", () => {
    const a = makeFact({ id: "a", causalChildren: ["b"] });
    const b = makeFact({ id: "b", causalParents: ["a"], causalChildren: ["c"] });
    const c = makeFact({ id: "c", causalParents: ["b"] });

    const results = expandCausalGraph([{ fact: c, score: 1.0 }], [a, b, c], {
      maxHops: 2,
      decayFactor: 0.8,
    });

    const ids = results.map((r) => r.fact.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);

    const bResult = results.find((r) => r.fact.id === "b");
    expect(bResult?.hops).toBe(1);
    expect(bResult?.score).toBeCloseTo(0.8, 5);

    const aResult = results.find((r) => r.fact.id === "a");
    expect(aResult?.hops).toBe(2);
    expect(aResult?.score).toBeCloseTo(0.64, 5);
  });

  test("branching: A→B, A→C, expand from A finds both", () => {
    const a = makeFact({ id: "a", causalChildren: ["b", "c"] });
    const b = makeFact({ id: "b", causalParents: ["a"] });
    const c = makeFact({ id: "c", causalParents: ["a"] });

    const results = expandCausalGraph([{ fact: a, score: 1.0 }], [a, b, c], {
      maxHops: 1,
      decayFactor: 0.8,
    });

    const ids = results.map((r) => r.fact.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  test("cycle: A→B→A, expand terminates and returns both", () => {
    const a = makeFact({ id: "a", causalChildren: ["b"], causalParents: ["b"] });
    const b = makeFact({ id: "b", causalChildren: ["a"], causalParents: ["a"] });

    const results = expandCausalGraph([{ fact: a, score: 1.0 }], [a, b], {
      maxHops: 5,
      decayFactor: 0.8,
    });

    const ids = results.map((r) => r.fact.id).sort();
    expect(ids).toEqual(["a", "b"]);
    // Should not infinite loop — cycle is detected via visited set
  });

  test("orphan reference: parent has causalChildren pointing to missing ID", () => {
    const a = makeFact({ id: "a", causalChildren: ["gone"] });

    const results = expandCausalGraph([{ fact: a, score: 1.0 }], [a], {
      maxHops: 2,
      decayFactor: 0.8,
    });

    // Only the seed should be returned
    expect(results).toHaveLength(1);
    expect(results[0]?.fact.id).toBe("a");
  });

  test("maxHops=0 returns only seed nodes", () => {
    const a = makeFact({ id: "a", causalChildren: ["b"] });
    const b = makeFact({ id: "b", causalParents: ["a"] });

    const results = expandCausalGraph([{ fact: a, score: 1.0 }], [a, b], {
      maxHops: 0,
      decayFactor: 0.8,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.fact.id).toBe("a");
    expect(results[0]?.score).toBe(1.0);
  });

  test("maxHops=1 returns only direct neighbors", () => {
    const a = makeFact({ id: "a", causalChildren: ["b"] });
    const b = makeFact({ id: "b", causalParents: ["a"], causalChildren: ["c"] });
    const c = makeFact({ id: "c", causalParents: ["b"] });

    const results = expandCausalGraph([{ fact: a, score: 1.0 }], [a, b, c], {
      maxHops: 1,
      decayFactor: 0.8,
    });

    const ids = results.map((r) => r.fact.id).sort();
    expect(ids).toEqual(["a", "b"]);
    // C is 2 hops away — should NOT be included
  });

  test("empty causal fields returns seeds unchanged", () => {
    const a = makeFact({ id: "a" }); // no causalParents or causalChildren
    const b = makeFact({ id: "b" });

    const results = expandCausalGraph([{ fact: a, score: 0.9 }], [a, b], {
      maxHops: 3,
      decayFactor: 0.8,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.fact.id).toBe("a");
    expect(results[0]?.score).toBe(0.9);
  });

  test("score decay: verify score * (0.8 ^ hops) arithmetic", () => {
    const a = makeFact({ id: "a", causalChildren: ["b"] });
    const b = makeFact({ id: "b", causalParents: ["a"], causalChildren: ["c"] });
    const c = makeFact({ id: "c", causalParents: ["b"], causalChildren: ["d"] });
    const d = makeFact({ id: "d", causalParents: ["c"] });

    const results = expandCausalGraph([{ fact: a, score: 1.0 }], [a, b, c, d], {
      maxHops: 3,
      decayFactor: 0.8,
    });

    const scoreMap = new Map(results.map((r) => [r.fact.id, r.score]));
    expect(scoreMap.get("a")).toBe(1.0);
    expect(scoreMap.get("b")).toBeCloseTo(0.8, 5); // 1.0 * 0.8^1
    expect(scoreMap.get("c")).toBeCloseTo(0.64, 5); // 1.0 * 0.8^2
    expect(scoreMap.get("d")).toBeCloseTo(0.512, 5); // 1.0 * 0.8^3
  });

  test("dedup: fact in both seeds and expansion keeps higher score", () => {
    const a = makeFact({ id: "a", causalChildren: ["b"] });
    const b = makeFact({ id: "b", causalParents: ["a"] });

    // B is both a seed (score=0.5) and reachable from A (score=0.8)
    const results = expandCausalGraph(
      [
        { fact: a, score: 1.0 },
        { fact: b, score: 0.5 },
      ],
      [a, b],
      { maxHops: 1, decayFactor: 0.8 },
    );

    const bResult = results.find((r) => r.fact.id === "b");
    // Via expansion from A: 1.0 * 0.8 = 0.8 > 0.5 (seed score)
    expect(bResult?.score).toBeCloseTo(0.8, 5);
  });
});
