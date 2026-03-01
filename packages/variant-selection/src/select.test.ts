import { describe, expect, test } from "bun:test";
import type { DegeneracyConfig } from "@koi/core";
import { selectVariant } from "./select.js";
import type { BreakerMap, VariantEntry, VariantPool } from "./types.js";

const DEFAULT_CONFIG: DegeneracyConfig = {
  selectionStrategy: "fitness",
  minVariants: 1,
  maxVariants: 3,
  failoverEnabled: true,
};

function makeEntry(id: string, fitnessScore: number): VariantEntry<string> {
  return { id, value: `handler-${id}`, fitnessScore };
}

function makePool(
  variants: readonly VariantEntry<string>[],
  strategy: DegeneracyConfig["selectionStrategy"] = "fitness",
): VariantPool<string> {
  return {
    capability: "test",
    variants,
    config: { ...DEFAULT_CONFIG, selectionStrategy: strategy },
  };
}

const EMPTY_BREAKERS: BreakerMap = new Map();
const defaultCtx = { clock: Date.now, random: () => 0.5 };

describe("selectVariant", () => {
  test("dispatches to fitness strategy", () => {
    const pool = makePool([makeEntry("a", 0.9)], "fitness");
    const result = selectVariant({
      pool,
      breakers: EMPTY_BREAKERS,
      strategy: "fitness",
      ctx: defaultCtx,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.selected.id).toBe("a");
  });

  test("dispatches to round-robin strategy", () => {
    const pool = makePool([makeEntry("a", 0.5), makeEntry("b", 0.5)], "round-robin");
    const state = { index: 0 };
    const r1 = selectVariant({
      pool,
      breakers: EMPTY_BREAKERS,
      strategy: "round-robin",
      ctx: defaultCtx,
      roundRobinState: state,
    });
    expect(r1.ok && r1.selected.id).toBe("a");

    const r2 = selectVariant({
      pool,
      breakers: EMPTY_BREAKERS,
      strategy: "round-robin",
      ctx: defaultCtx,
      roundRobinState: state,
    });
    expect(r2.ok && r2.selected.id).toBe("b");
  });

  test("dispatches to context-match strategy", () => {
    const pool = makePool([makeEntry("a", 0.5), makeEntry("b", 0.9)], "context-match");
    const result = selectVariant({
      pool,
      breakers: EMPTY_BREAKERS,
      strategy: "context-match",
      ctx: defaultCtx,
      contextMatcher: (v) => (v.id === "a" ? 10 : 1),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.selected.id).toBe("a");
  });

  test("dispatches to random strategy", () => {
    const pool = makePool([makeEntry("a", 0.5)], "random");
    const result = selectVariant({
      pool,
      breakers: EMPTY_BREAKERS,
      strategy: "random",
      ctx: { ...defaultCtx, random: () => 0 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.selected.id).toBe("a");
  });

  test("context-match uses default matcher when none provided", () => {
    const pool = makePool([makeEntry("a", 0.9), makeEntry("b", 0.3)], "context-match");
    const result = selectVariant({
      pool,
      breakers: EMPTY_BREAKERS,
      strategy: "context-match",
      ctx: defaultCtx,
    });
    // With default matcher (returns 0 for all), ties broken by fitness
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.selected.id).toBe("a");
  });

  test("round-robin uses default state when none provided", () => {
    const pool = makePool([makeEntry("a", 0.5)], "round-robin");
    const result = selectVariant({
      pool,
      breakers: EMPTY_BREAKERS,
      strategy: "round-robin",
      ctx: defaultCtx,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.selected.id).toBe("a");
  });
});
