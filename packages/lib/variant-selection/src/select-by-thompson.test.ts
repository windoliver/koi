import { describe, expect, test } from "bun:test";
import type { DegeneracyConfig } from "@koi/core";
import {
  createThompsonState,
  selectByThompson,
  type ThompsonState,
  type ThompsonStates,
  updateThompson,
} from "./select-by-thompson.js";
import type { BreakerMap, VariantEntry, VariantPool } from "./types.js";

const DEFAULT_CONFIG: DegeneracyConfig = {
  selectionStrategy: "thompson",
  minVariants: 1,
  maxVariants: 3,
  failoverEnabled: true,
};

function makeEntry<T>(id: string, value: T, fitnessScore: number): VariantEntry<T> {
  return { id, value, fitnessScore };
}

function makePool<T>(variants: readonly VariantEntry<T>[]): VariantPool<T> {
  return { capability: "test", variants, config: DEFAULT_CONFIG };
}

/** Deterministic seeded PRNG for reproducible tests. */
function makeSeededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function makeCtx(random: () => number) {
  return { clock: Date.now, random };
}

const EMPTY_BREAKERS: BreakerMap = new Map();
const EMPTY_STATES: ThompsonStates = new Map();

describe("createThompsonState", () => {
  test("returns uniform prior Beta(1, 1)", () => {
    const state = createThompsonState();
    expect(state.alpha).toBe(1);
    expect(state.beta).toBe(1);
  });
});

describe("updateThompson", () => {
  test("increments alpha on success", () => {
    const state: ThompsonState = { alpha: 1, beta: 1 };
    const updated = updateThompson(state, true);
    expect(updated.alpha).toBe(2);
    expect(updated.beta).toBe(1);
  });

  test("increments beta on failure", () => {
    const state: ThompsonState = { alpha: 1, beta: 1 };
    const updated = updateThompson(state, false);
    expect(updated.alpha).toBe(1);
    expect(updated.beta).toBe(2);
  });

  test("does not mutate original state", () => {
    const state: ThompsonState = { alpha: 3, beta: 5 };
    const updated = updateThompson(state, true);
    expect(state.alpha).toBe(3);
    expect(state.beta).toBe(5);
    expect(updated.alpha).toBe(4);
  });

  test("accumulates correctly over multiple updates", () => {
    let state = createThompsonState();
    state = updateThompson(state, true);
    state = updateThompson(state, true);
    state = updateThompson(state, false);
    state = updateThompson(state, true);
    expect(state.alpha).toBe(4); // 1 + 3 successes
    expect(state.beta).toBe(2); // 1 + 1 failure
  });
});

describe("selectByThompson", () => {
  test("returns ok: false for empty pool", () => {
    const result = selectByThompson(
      makePool([]),
      EMPTY_BREAKERS,
      EMPTY_STATES,
      makeCtx(() => 0.5),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("No variants");
    }
  });

  test("returns single variant when pool has one entry", () => {
    const pool = makePool([makeEntry("a", "tool-a", 0.8)]);
    const result = selectByThompson(
      pool,
      EMPTY_BREAKERS,
      EMPTY_STATES,
      makeCtx(() => 0.5),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selected.id).toBe("a");
      expect(result.alternatives).toHaveLength(0);
    }
  });

  test("selected is always from pool", () => {
    const pool = makePool([makeEntry("a", "tool-a", 0.5), makeEntry("b", "tool-b", 0.5)]);
    const random = makeSeededRandom(42);
    for (let i = 0; i < 50; i++) {
      const result = selectByThompson(pool, EMPTY_BREAKERS, EMPTY_STATES, makeCtx(random));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(["a", "b"]).toContain(result.selected.id);
      }
    }
  });

  test("variant with many successes is selected more often", () => {
    const pool = makePool([makeEntry("good", "tool-good", 0.5), makeEntry("bad", "tool-bad", 0.5)]);
    // good: Beta(20, 2) — high success rate
    // bad: Beta(2, 20) — low success rate
    const states: ThompsonStates = new Map([
      ["good", { alpha: 20, beta: 2 }],
      ["bad", { alpha: 2, beta: 20 }],
    ]);

    let goodCount = 0;
    const runs = 1000;
    const random = makeSeededRandom(123);
    for (let i = 0; i < runs; i++) {
      const result = selectByThompson(pool, EMPTY_BREAKERS, states, makeCtx(random));
      if (result.ok && result.selected.id === "good") goodCount++;
    }
    // With Beta(20, 2) vs Beta(2, 20), good should dominate (>90%)
    expect(goodCount / runs).toBeGreaterThan(0.9);
  });

  test("uniform priors produce roughly even selection", () => {
    const pool = makePool([makeEntry("a", "tool-a", 0.5), makeEntry("b", "tool-b", 0.5)]);
    // Both Beta(1, 1) — uniform
    const states: ThompsonStates = new Map([
      ["a", { alpha: 1, beta: 1 }],
      ["b", { alpha: 1, beta: 1 }],
    ]);

    let aCount = 0;
    const runs = 1000;
    const random = makeSeededRandom(456);
    for (let i = 0; i < runs; i++) {
      const result = selectByThompson(pool, EMPTY_BREAKERS, states, makeCtx(random));
      if (result.ok && result.selected.id === "a") aCount++;
    }
    // With uniform priors, expect roughly 50% ± 10%
    expect(aCount / runs).toBeGreaterThan(0.35);
    expect(aCount / runs).toBeLessThan(0.65);
  });

  test("variants without state entries use uniform prior", () => {
    const pool = makePool([makeEntry("a", "tool-a", 0.5), makeEntry("b", "tool-b", 0.5)]);
    // Only "a" has state — high success. "b" gets default Beta(1, 1).
    const states: ThompsonStates = new Map([["a", { alpha: 50, beta: 2 }]]);

    let aCount = 0;
    const runs = 1000;
    const random = makeSeededRandom(789);
    for (let i = 0; i < runs; i++) {
      const result = selectByThompson(pool, EMPTY_BREAKERS, states, makeCtx(random));
      if (result.ok && result.selected.id === "a") aCount++;
    }
    // a has Beta(50, 2) ≈ mean 0.96, b has Beta(1, 1) ≈ mean 0.5
    // a should dominate
    expect(aCount / runs).toBeGreaterThan(0.85);
  });

  test("skips variants with open circuit breakers", () => {
    const pool = makePool([makeEntry("a", "tool-a", 0.5), makeEntry("b", "tool-b", 0.5)]);
    const breakers: BreakerMap = new Map([
      [
        "a",
        {
          isAllowed: () => false,
          recordSuccess: () => ({}) as never,
          recordFailure: () => ({}) as never,
          getSnapshot: () => ({}) as never,
          reset: () => {},
        },
      ],
    ]);
    const result = selectByThompson(
      pool,
      breakers,
      EMPTY_STATES,
      makeCtx(() => 0.5),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selected.id).toBe("b");
    }
  });

  test("graceful degradation when all breakers are open", () => {
    const pool = makePool([makeEntry("a", "tool-a", 0.5), makeEntry("b", "tool-b", 0.5)]);
    const breakers: BreakerMap = new Map([
      [
        "a",
        {
          isAllowed: () => false,
          recordSuccess: () => ({}) as never,
          recordFailure: () => ({}) as never,
          getSnapshot: () => ({}) as never,
          reset: () => {},
        },
      ],
      [
        "b",
        {
          isAllowed: () => false,
          recordSuccess: () => ({}) as never,
          recordFailure: () => ({}) as never,
          getSnapshot: () => ({}) as never,
          reset: () => {},
        },
      ],
    ]);
    const result = selectByThompson(pool, breakers, EMPTY_STATES, makeCtx(makeSeededRandom(42)));
    expect(result.ok).toBe(true);
  });

  test("alternatives excludes the selected variant", () => {
    const pool = makePool([
      makeEntry("a", "tool-a", 0.5),
      makeEntry("b", "tool-b", 0.5),
      makeEntry("c", "tool-c", 0.5),
    ]);
    const random = makeSeededRandom(42);
    for (let i = 0; i < 20; i++) {
      const result = selectByThompson(pool, EMPTY_BREAKERS, EMPTY_STATES, makeCtx(random));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.alternatives.every((a) => a.id !== result.selected.id)).toBe(true);
        expect(result.alternatives).toHaveLength(2);
      }
    }
  });

  test("three-arm convergence: clear winner dominates", () => {
    const pool = makePool([
      makeEntry("best", "tool-best", 0.5),
      makeEntry("mid", "tool-mid", 0.5),
      makeEntry("worst", "tool-worst", 0.5),
    ]);
    const states: ThompsonStates = new Map([
      ["best", { alpha: 30, beta: 3 }], // ~91% success rate
      ["mid", { alpha: 10, beta: 10 }], // ~50% success rate
      ["worst", { alpha: 3, beta: 30 }], // ~9% success rate
    ]);

    const counts = { best: 0, mid: 0, worst: 0 };
    const runs = 1000;
    const random = makeSeededRandom(101);
    for (let i = 0; i < runs; i++) {
      const result = selectByThompson(pool, EMPTY_BREAKERS, states, makeCtx(random));
      if (result.ok) counts[result.selected.id as keyof typeof counts]++;
    }
    // best should dominate, worst should be rare
    expect(counts.best / runs).toBeGreaterThan(0.7);
    expect(counts.worst / runs).toBeLessThan(0.05);
  });
});
