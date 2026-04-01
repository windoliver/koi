import { describe, expect, test } from "bun:test";
import type { DegeneracyConfig } from "@koi/core";
import { selectByFitness } from "./select-by-fitness.js";
import type { BreakerMap, VariantEntry, VariantPool } from "./types.js";

const DEFAULT_CONFIG: DegeneracyConfig = {
  selectionStrategy: "fitness",
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

function makeCtx(random: () => number) {
  return { clock: Date.now, random };
}

const EMPTY_BREAKERS: BreakerMap = new Map();

describe("selectByFitness", () => {
  test("returns ok: false for empty pool", () => {
    const result = selectByFitness(
      makePool([]),
      EMPTY_BREAKERS,
      makeCtx(() => 0.5),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("No variants");
    }
  });

  test("returns single variant when pool has one entry", () => {
    const pool = makePool([makeEntry("a", "tool-a", 0.8)]);
    const result = selectByFitness(
      pool,
      EMPTY_BREAKERS,
      makeCtx(() => 0.5),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selected.id).toBe("a");
      expect(result.alternatives).toHaveLength(0);
    }
  });

  test("selected is always from pool", () => {
    const pool = makePool([makeEntry("a", "tool-a", 0.9), makeEntry("b", "tool-b", 0.1)]);
    for (let i = 0; i < 50; i++) {
      const result = selectByFitness(
        pool,
        EMPTY_BREAKERS,
        makeCtx(() => Math.random()),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(["a", "b"]).toContain(result.selected.id);
      }
    }
  });

  test("higher fitness gets selected more often", () => {
    const pool = makePool([makeEntry("high", "tool-high", 0.9), makeEntry("low", "tool-low", 0.1)]);
    let highCount = 0;
    const runs = 1000;
    // Use deterministic seeded random
    let seed = 42;
    const seededRandom = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    for (let i = 0; i < runs; i++) {
      const result = selectByFitness(pool, EMPTY_BREAKERS, makeCtx(seededRandom));
      if (result.ok && result.selected.id === "high") highCount++;
    }
    // High fitness (0.9) should be selected ~90% of the time
    expect(highCount / runs).toBeGreaterThan(0.7);
  });

  test("skips variants with open circuit breakers", () => {
    const pool = makePool([makeEntry("a", "tool-a", 0.9), makeEntry("b", "tool-b", 0.8)]);
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
    const result = selectByFitness(
      pool,
      breakers,
      makeCtx(() => 0.5),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selected.id).toBe("b");
    }
  });

  test("graceful degradation when all breakers are open", () => {
    const pool = makePool([makeEntry("a", "tool-a", 0.9), makeEntry("b", "tool-b", 0.8)]);
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
    const result = selectByFitness(
      pool,
      breakers,
      makeCtx(() => 0.5),
    );
    expect(result.ok).toBe(true);
  });

  test("all variants with zero fitness still get selected (minimum weight)", () => {
    const pool = makePool([makeEntry("a", "tool-a", 0), makeEntry("b", "tool-b", 0)]);
    const result = selectByFitness(
      pool,
      EMPTY_BREAKERS,
      makeCtx(() => 0.5),
    );
    expect(result.ok).toBe(true);
  });

  test("alternatives excludes the selected variant", () => {
    const pool = makePool([
      makeEntry("a", "tool-a", 0.5),
      makeEntry("b", "tool-b", 0.5),
      makeEntry("c", "tool-c", 0.5),
    ]);
    const result = selectByFitness(
      pool,
      EMPTY_BREAKERS,
      makeCtx(() => 0.1),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alternatives.every((a) => a.id !== result.selected.id)).toBe(true);
      expect(result.alternatives).toHaveLength(2);
    }
  });
});
