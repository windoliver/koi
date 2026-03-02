import { describe, expect, test } from "bun:test";
import type { DegeneracyConfig } from "@koi/core";
import { createCircuitBreaker } from "@koi/errors";
import { executeWithFailover } from "./execute-with-failover.js";
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
  config?: Partial<DegeneracyConfig>,
): VariantPool<string> {
  return {
    capability: "test",
    variants,
    config: { ...DEFAULT_CONFIG, ...config },
  };
}

let now = 1000;
const clock = () => now;

describe("executeWithFailover", () => {
  test("primary succeeds — no failover, returns result", async () => {
    const pool = makePool([makeEntry("a", 0.9), makeEntry("b", 0.5)]);
    const breakers: BreakerMap = new Map();
    now = 1000;

    const result = await executeWithFailover({
      pool,
      breakers,
      selectOptions: { strategy: "fitness", ctx: { clock, random: () => 0.1 } },
      execute: async (v) => {
        now = 1010;
        return `result-${v.id}`;
      },
      clock,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.result).toContain("result-");
      expect(result.value.attempts).toHaveLength(1);
      expect(result.value.attempts[0]?.success).toBe(true);
    }
  });

  test("primary fails, alternative succeeds — failover works", async () => {
    const pool = makePool([makeEntry("a", 0.9), makeEntry("b", 0.5)]);
    const breakers: BreakerMap = new Map([
      ["a", createCircuitBreaker(undefined, clock)],
      ["b", createCircuitBreaker(undefined, clock)],
    ]);
    now = 1000;

    const result = await executeWithFailover({
      pool,
      breakers,
      selectOptions: { strategy: "fitness", ctx: { clock, random: () => 0.1 } },
      execute: async (v) => {
        now += 5;
        if (v.id === "a") throw new Error("primary failed");
        return `result-${v.id}`;
      },
      clock,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.result).toBe("result-b");
      expect(result.value.attempts).toHaveLength(2);
      expect(result.value.attempts[0]?.success).toBe(false);
      expect(result.value.attempts[1]?.success).toBe(true);
    }
  });

  test("all variants fail — returns aggregate error", async () => {
    const pool = makePool([makeEntry("a", 0.9), makeEntry("b", 0.5)]);
    const breakers: BreakerMap = new Map();
    now = 1000;

    const result = await executeWithFailover({
      pool,
      breakers,
      selectOptions: { strategy: "fitness", ctx: { clock, random: () => 0.1 } },
      execute: async (v) => {
        now += 5;
        throw new Error(`${v.id} failed`);
      },
      clock,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts.every((a) => !a.success)).toBe(true);
    }
  });

  test("failover disabled — primary failure is final", async () => {
    const pool = makePool([makeEntry("a", 0.9), makeEntry("b", 0.5)], {
      failoverEnabled: false,
    });
    const breakers: BreakerMap = new Map();
    now = 1000;

    const result = await executeWithFailover({
      pool,
      breakers,
      selectOptions: { strategy: "fitness", ctx: { clock, random: () => 0.1 } },
      execute: async (v) => {
        now += 5;
        if (v.id === "a") throw new Error("primary failed");
        return `result-${v.id}`;
      },
      clock,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toHaveLength(1);
    }
  });

  test("empty pool — returns error with no attempts", async () => {
    const pool = makePool([]);
    const breakers: BreakerMap = new Map();

    const result = await executeWithFailover({
      pool,
      breakers,
      selectOptions: { strategy: "fitness", ctx: { clock, random: () => 0.5 } },
      execute: async () => "never",
      clock,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toHaveLength(0);
    }
  });

  test("circuit breaker skips alternative with open breaker", async () => {
    const pool = makePool([makeEntry("a", 0.9), makeEntry("b", 0.5), makeEntry("c", 0.3)]);
    // 'b' has open breaker
    const bBreaker = createCircuitBreaker(
      { failureThreshold: 1, cooldownMs: 60_000, failureWindowMs: 60_000, failureStatusCodes: [] },
      clock,
    );
    bBreaker.recordFailure(); // opens the breaker
    const breakers: BreakerMap = new Map([
      ["a", createCircuitBreaker(undefined, clock)],
      ["b", bBreaker],
      ["c", createCircuitBreaker(undefined, clock)],
    ]);
    now = 1000;

    const result = await executeWithFailover({
      pool,
      breakers,
      selectOptions: { strategy: "fitness", ctx: { clock, random: () => 0.01 } },
      execute: async (v) => {
        now += 5;
        // Primary 'a' fails, then 'b' should be skipped, 'c' succeeds
        if (v.id === "a") throw new Error("primary failed");
        return `result-${v.id}`;
      },
      clock,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.result).toBe("result-c");
      // Only 2 attempts: 'a' (failed) and 'c' (succeeded), 'b' was skipped
      expect(result.value.attempts).toHaveLength(2);
    }
  });

  test("attempts.length <= pool.variants.length", async () => {
    const variants = [makeEntry("a", 0.9), makeEntry("b", 0.5), makeEntry("c", 0.3)];
    const pool = makePool(variants);
    const breakers: BreakerMap = new Map();
    now = 1000;

    const result = await executeWithFailover({
      pool,
      breakers,
      selectOptions: { strategy: "fitness", ctx: { clock, random: () => 0.1 } },
      execute: async (v) => {
        now += 5;
        throw new Error(`${v.id} failed`);
      },
      clock,
    });

    if (!result.ok) {
      expect(result.attempts.length).toBeLessThanOrEqual(variants.length);
    }
  });

  test("records duration correctly on success and failure", async () => {
    const pool = makePool([makeEntry("a", 0.9), makeEntry("b", 0.5)]);
    const breakers: BreakerMap = new Map();
    now = 1000;

    const result = await executeWithFailover({
      pool,
      breakers,
      selectOptions: { strategy: "fitness", ctx: { clock, random: () => 0.1 } },
      execute: async (v) => {
        now += 100; // 100ms per call
        if (v.id === "a") throw new Error("slow failure");
        return "ok";
      },
      clock,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.attempts[0]?.durationMs).toBe(100);
      expect(result.value.attempts[1]?.durationMs).toBe(100);
    }
  });
});
