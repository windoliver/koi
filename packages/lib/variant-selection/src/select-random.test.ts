import { describe, expect, test } from "bun:test";
import type { DegeneracyConfig } from "@koi/core";
import { selectRandom } from "./select-random.js";
import type { BreakerMap, VariantEntry, VariantPool } from "./types.js";

const DEFAULT_CONFIG: DegeneracyConfig = {
  selectionStrategy: "random",
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

const EMPTY_BREAKERS: BreakerMap = new Map();

describe("selectRandom", () => {
  test("returns ok: false for empty pool", () => {
    const result = selectRandom(makePool([]), EMPTY_BREAKERS, {
      clock: Date.now,
      random: () => 0.5,
    });
    expect(result.ok).toBe(false);
  });

  test("returns the only variant for single-entry pool", () => {
    const pool = makePool([makeEntry("a", "tool-a", 0.5)]);
    const result = selectRandom(pool, EMPTY_BREAKERS, { clock: Date.now, random: () => 0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selected.id).toBe("a");
      expect(result.alternatives).toHaveLength(0);
    }
  });

  test("distributes uniformly over many calls with seeded RNG", () => {
    const pool = makePool([
      makeEntry("a", "tool-a", 0.5),
      makeEntry("b", "tool-b", 0.5),
      makeEntry("c", "tool-c", 0.5),
    ]);
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const runs = 3000;
    let seed = 12345;
    const seededRandom = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    for (let i = 0; i < runs; i++) {
      const result = selectRandom(pool, EMPTY_BREAKERS, { clock: Date.now, random: seededRandom });
      if (result.ok) {
        counts[result.selected.id] = (counts[result.selected.id] ?? 0) + 1;
      }
    }
    // Each variant should get roughly 1/3 of the selections (±10%)
    for (const id of ["a", "b", "c"]) {
      const ratio = (counts[id] ?? 0) / runs;
      expect(ratio).toBeGreaterThan(0.2);
      expect(ratio).toBeLessThan(0.5);
    }
  });

  test("selected is always from pool", () => {
    const pool = makePool([makeEntry("x", "tool-x", 0.3), makeEntry("y", "tool-y", 0.7)]);
    for (let i = 0; i < 50; i++) {
      const result = selectRandom(pool, EMPTY_BREAKERS, { clock: Date.now, random: Math.random });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(["x", "y"]).toContain(result.selected.id);
      }
    }
  });

  test("skips open circuit breakers", () => {
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
    const result = selectRandom(pool, breakers, { clock: Date.now, random: () => 0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selected.id).toBe("b");
    }
  });
});
