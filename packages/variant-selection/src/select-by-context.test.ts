import { describe, expect, test } from "bun:test";
import type { DegeneracyConfig } from "@koi/core";
import { selectByContext } from "./select-by-context.js";
import type { BreakerMap, ContextMatcher, VariantEntry, VariantPool } from "./types.js";

const DEFAULT_CONFIG: DegeneracyConfig = {
  selectionStrategy: "context-match",
  minVariants: 1,
  maxVariants: 3,
  failoverEnabled: true,
};

function makeEntry(id: string, fitnessScore: number): VariantEntry<string> {
  return { id, value: `handler-${id}`, fitnessScore };
}

function makePool(variants: readonly VariantEntry<string>[]): VariantPool<string> {
  return { capability: "test", variants, config: DEFAULT_CONFIG };
}

const EMPTY_BREAKERS: BreakerMap = new Map();
const defaultCtx = { clock: Date.now, random: () => 0.5 };

describe("selectByContext", () => {
  test("returns ok: false for empty pool", () => {
    const matcher: ContextMatcher<string> = () => 0;
    const result = selectByContext(makePool([]), EMPTY_BREAKERS, matcher, defaultCtx);
    expect(result.ok).toBe(false);
  });

  test("selects variant with highest matcher score", () => {
    const pool = makePool([
      makeEntry("api", 0.9),
      makeEntry("scrape", 0.5),
      makeEntry("cache", 0.3),
    ]);
    // Matcher prefers "scrape"
    const matcher: ContextMatcher<string> = (v) => (v.id === "scrape" ? 10 : 1);
    const result = selectByContext(pool, EMPTY_BREAKERS, matcher, defaultCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selected.id).toBe("scrape");
    }
  });

  test("breaks ties by fitness score", () => {
    const pool = makePool([makeEntry("a", 0.3), makeEntry("b", 0.9)]);
    // Equal matcher scores
    const matcher: ContextMatcher<string> = () => 5;
    const result = selectByContext(pool, EMPTY_BREAKERS, matcher, defaultCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selected.id).toBe("b"); // higher fitness
    }
  });

  test("uses input context for matching", () => {
    const pool = makePool([makeEntry("api", 0.5), makeEntry("scrape", 0.5)]);
    const matcher: ContextMatcher<string> = (v, input) => {
      const query = (input as Record<string, unknown> | undefined)?.query;
      if (typeof query === "string" && query.includes("url") && v.id === "scrape") return 10;
      return 1;
    };
    const ctx = { ...defaultCtx, input: { query: "fetch url content" } };
    const result = selectByContext(pool, EMPTY_BREAKERS, matcher, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selected.id).toBe("scrape");
    }
  });

  test("skips open circuit breakers", () => {
    const pool = makePool([makeEntry("a", 0.9), makeEntry("b", 0.5)]);
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
    const matcher: ContextMatcher<string> = (v) => (v.id === "a" ? 10 : 5);
    const result = selectByContext(pool, breakers, matcher, defaultCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selected.id).toBe("b");
    }
  });

  test("graceful degradation when all breakers open", () => {
    const pool = makePool([makeEntry("a", 0.9), makeEntry("b", 0.5)]);
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
    const matcher: ContextMatcher<string> = () => 1;
    const result = selectByContext(pool, breakers, matcher, defaultCtx);
    expect(result.ok).toBe(true);
  });

  test("alternatives exclude selected", () => {
    const pool = makePool([makeEntry("a", 0.5), makeEntry("b", 0.5), makeEntry("c", 0.5)]);
    const matcher: ContextMatcher<string> = () => 1;
    const result = selectByContext(pool, EMPTY_BREAKERS, matcher, defaultCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alternatives.every((v) => v.id !== result.selected.id)).toBe(true);
      expect(result.alternatives).toHaveLength(2);
    }
  });
});
