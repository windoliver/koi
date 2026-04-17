import { describe, expect, test } from "bun:test";
import { createFlatRateCostCalculator } from "@koi/governance-core";
import { createFlatRateCostCalculator as localCreate } from "../cost-calculator.js";
import { DEFAULT_PRICING } from "../default-pricing.js";

describe("DEFAULT_PRICING", () => {
  test("includes the canonical model set", () => {
    const expected = [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-5",
      "gpt-5-mini",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ];
    for (const model of expected) {
      expect(DEFAULT_PRICING[model]).toBeDefined();
    }
  });

  test("every entry has positive input and output rates", () => {
    for (const [model, entry] of Object.entries(DEFAULT_PRICING)) {
      expect(entry.inputUsdPer1M).toBeGreaterThan(0);
      expect(entry.outputUsdPer1M).toBeGreaterThan(0);
      expect(`${model}:${entry.inputUsdPer1M}`).toMatch(/^[a-z0-9-]+:\d/);
    }
  });

  test("is frozen so callers cannot mutate the shared table", () => {
    expect(Object.isFrozen(DEFAULT_PRICING)).toBe(true);
  });
});

describe("DEFAULT_PRICING with createFlatRateCostCalculator", () => {
  const calc = createFlatRateCostCalculator(DEFAULT_PRICING);

  test("gpt-4o-mini flat-rate math: 1M input + 1M output", () => {
    const cost = calc.calculate("gpt-4o-mini", 1_000_000, 1_000_000);
    const expected = DEFAULT_PRICING["gpt-4o-mini"];
    expect(expected).toBeDefined();
    if (expected !== undefined) {
      expect(cost).toBeCloseTo(expected.inputUsdPer1M + expected.outputUsdPer1M, 10);
    }
  });

  test("claude-sonnet-4-6 flat-rate math: 500k input + 200k output", () => {
    const cost = calc.calculate("claude-sonnet-4-6", 500_000, 200_000);
    const entry = DEFAULT_PRICING["claude-sonnet-4-6"];
    expect(entry).toBeDefined();
    if (entry !== undefined) {
      const expected = 0.5 * entry.inputUsdPer1M + 0.2 * entry.outputUsdPer1M;
      expect(cost).toBeCloseTo(expected, 10);
    }
  });

  test("claude-haiku-4-5 flat-rate math: 10k input + 5k output", () => {
    const cost = calc.calculate("claude-haiku-4-5", 10_000, 5_000);
    const entry = DEFAULT_PRICING["claude-haiku-4-5"];
    expect(entry).toBeDefined();
    if (entry !== undefined) {
      const expected = 0.01 * entry.inputUsdPer1M + 0.005 * entry.outputUsdPer1M;
      expect(cost).toBeCloseTo(expected, 10);
    }
  });

  test("caller-supplied overrides merge cleanly via object spread", () => {
    const custom = { ...DEFAULT_PRICING, foo: { inputUsdPer1M: 1, outputUsdPer1M: 2 } };
    const overriden = createFlatRateCostCalculator(custom);
    expect(overriden.calculate("foo", 1_000_000, 1_000_000)).toBeCloseTo(3, 10);
    expect(overriden.calculate("gpt-4o-mini", 1_000_000, 0)).toBeCloseTo(
      DEFAULT_PRICING["gpt-4o-mini"]?.inputUsdPer1M ?? 0,
      10,
    );
  });
});

describe("createFlatRateCostCalculator validation (local)", () => {
  const calc = localCreate(DEFAULT_PRICING);

  test("throws VALIDATION for unknown model", () => {
    expect(() => calc.calculate("unknown-model", 100, 100)).toThrow(/Unknown model/);
  });

  test("throws VALIDATION for non-finite input tokens", () => {
    expect(() => calc.calculate("gpt-4o-mini", Number.NaN, 100)).toThrow(/inputTokens/);
  });

  test("throws VALIDATION for negative output tokens", () => {
    expect(() => calc.calculate("gpt-4o-mini", 100, -1)).toThrow(/outputTokens/);
  });
});
