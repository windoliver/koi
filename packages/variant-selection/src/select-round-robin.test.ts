import { describe, expect, test } from "bun:test";
import type { DegeneracyConfig } from "@koi/core";
import { createRoundRobinState, selectRoundRobin } from "./select-round-robin.js";
import type { BreakerMap, VariantEntry, VariantPool } from "./types.js";

const DEFAULT_CONFIG: DegeneracyConfig = {
  selectionStrategy: "round-robin",
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

describe("selectRoundRobin", () => {
  test("returns ok: false for empty pool", () => {
    const state = createRoundRobinState();
    const result = selectRoundRobin(makePool([]), EMPTY_BREAKERS, state);
    expect(result.ok).toBe(false);
  });

  test("cycles through variants in order", () => {
    const pool = makePool([
      makeEntry("a", "tool-a", 0.5),
      makeEntry("b", "tool-b", 0.5),
      makeEntry("c", "tool-c", 0.5),
    ]);
    const state = createRoundRobinState();

    const r1 = selectRoundRobin(pool, EMPTY_BREAKERS, state);
    expect(r1.ok && r1.selected.id).toBe("a");

    const r2 = selectRoundRobin(pool, EMPTY_BREAKERS, state);
    expect(r2.ok && r2.selected.id).toBe("b");

    const r3 = selectRoundRobin(pool, EMPTY_BREAKERS, state);
    expect(r3.ok && r3.selected.id).toBe("c");

    // Wraps around
    const r4 = selectRoundRobin(pool, EMPTY_BREAKERS, state);
    expect(r4.ok && r4.selected.id).toBe("a");
  });

  test("skips open breakers", () => {
    const pool = makePool([
      makeEntry("a", "tool-a", 0.5),
      makeEntry("b", "tool-b", 0.5),
      makeEntry("c", "tool-c", 0.5),
    ]);
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
    const state = createRoundRobinState();

    const r1 = selectRoundRobin(pool, breakers, state);
    expect(r1.ok && r1.selected.id).toBe("b");

    const r2 = selectRoundRobin(pool, breakers, state);
    expect(r2.ok && r2.selected.id).toBe("c");

    // Skips 'a' again
    const r3 = selectRoundRobin(pool, breakers, state);
    expect(r3.ok && r3.selected.id).toBe("b");
  });

  test("graceful degradation when all breakers open", () => {
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
    const state = createRoundRobinState();
    const result = selectRoundRobin(pool, breakers, state);
    expect(result.ok).toBe(true);
  });

  test("alternatives exclude selected", () => {
    const pool = makePool([makeEntry("a", "tool-a", 0.5), makeEntry("b", "tool-b", 0.5)]);
    const state = createRoundRobinState();
    const result = selectRoundRobin(pool, EMPTY_BREAKERS, state);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alternatives.every((v) => v.id !== result.selected.id)).toBe(true);
    }
  });
});
