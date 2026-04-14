import { describe, expect, test } from "bun:test";
import { createCostCalculator } from "./calculator.js";
import { DEFAULT_PRICING, resolvePricing } from "./pricing.js";

// ---------------------------------------------------------------------------
// resolvePricing — model lookup with alias fallback
// ---------------------------------------------------------------------------

describe("resolvePricing", () => {
  test("exact match returns pricing", () => {
    const result = resolvePricing("gpt-4o", DEFAULT_PRICING);
    expect(result).toBeDefined();
    expect(result?.input).toBe(2.5e-6);
  });

  test("date-suffix alias resolves to base model", () => {
    const result = resolvePricing("gpt-4o-20241120", DEFAULT_PRICING);
    // "gpt-4o-20241120" strips to "gpt-4o" (but gpt-4o-2024-11-20 is exact match)
    // The pattern matches -YYYYMMDD at end
    expect(result).toBeDefined();
  });

  test("unknown model returns undefined", () => {
    const result = resolvePricing("llama-3-70b", DEFAULT_PRICING);
    expect(result).toBeUndefined();
  });

  test("exact match takes priority over alias", () => {
    const table = {
      "model-base": { input: 1e-6, output: 5e-6 },
      "model-base-20260101": { input: 2e-6, output: 10e-6 },
    };
    const result = resolvePricing("model-base-20260101", table);
    expect(result?.input).toBe(2e-6);
  });

  test("date suffix stripped correctly", () => {
    const table = { "claude-sonnet-4-6": { input: 3e-6, output: 15e-6 } };
    const result = resolvePricing("claude-sonnet-4-6-20260414", table);
    expect(result?.input).toBe(3e-6);
  });
});

// ---------------------------------------------------------------------------
// createCostCalculator — simple calculate()
// ---------------------------------------------------------------------------

describe("createCostCalculator", () => {
  describe("calculate (simple)", () => {
    test("known model returns correct cost", () => {
      const calc = createCostCalculator();
      const cost = calc.calculate("gpt-4o", 1000, 500);
      // gpt-4o: input 2.5e-6, output 10e-6
      const expected = 1000 * 2.5e-6 + 500 * 10e-6;
      expect(cost).toBeCloseTo(expected, 10);
    });

    test("unknown model returns 0", () => {
      const calc = createCostCalculator();
      expect(calc.calculate("unknown-model", 1000, 500)).toBe(0);
    });

    test("zero tokens returns 0", () => {
      const calc = createCostCalculator();
      expect(calc.calculate("gpt-4o", 0, 0)).toBe(0);
    });

    test("pricing override takes precedence", () => {
      const calc = createCostCalculator({
        pricingOverrides: { "gpt-4o": { input: 100e-6, output: 200e-6 } },
      });
      const cost = calc.calculate("gpt-4o", 100, 50);
      expect(cost).toBeCloseTo(100 * 100e-6 + 50 * 200e-6, 10);
    });

    test("override for custom model", () => {
      const calc = createCostCalculator({
        pricingOverrides: { "my-custom-model": { input: 1e-6, output: 2e-6 } },
      });
      const cost = calc.calculate("my-custom-model", 1000, 500);
      expect(cost).toBeCloseTo(1000 * 1e-6 + 500 * 2e-6, 10);
    });

    test("fallback to default when override does not match", () => {
      const calc = createCostCalculator({
        pricingOverrides: { "other-model": { input: 1e-6, output: 2e-6 } },
      });
      // gpt-4o should still resolve from DEFAULT_PRICING
      const cost = calc.calculate("gpt-4o", 1000, 500);
      expect(cost).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // calculateDetailed — tiered pricing (Decision 10A edge cases)
  // -------------------------------------------------------------------------

  describe("calculateDetailed", () => {
    test("basic input/output matches simple calculate", () => {
      const calc = createCostCalculator();
      const simple = calc.calculate("gpt-4o", 1000, 500);
      const detailed = calc.calculateDetailed?.("gpt-4o", {
        inputTokens: 1000,
        outputTokens: 500,
      });
      expect(detailed).toBeCloseTo(simple, 10);
    });

    // --- Cached input tokens ---

    test("cached input tokens use discounted rate", () => {
      const calc = createCostCalculator();
      // claude-opus-4-6: input 15e-6, cachedInput 1.5e-6
      const withCache = calc.calculateDetailed?.("claude-opus-4-6", {
        inputTokens: 1000,
        outputTokens: 100,
        cachedInputTokens: 800,
      });
      const withoutCache = calc.calculateDetailed?.("claude-opus-4-6", {
        inputTokens: 1000,
        outputTokens: 100,
      });
      // 800 tokens at 1.5e-6 instead of 15e-6 = massive savings
      expect(withCache).toBeLessThan(withoutCache);
    });

    test("cached tokens deducted from regular input", () => {
      const calc = createCostCalculator();
      // All input is cached: 1000 cached out of 1000 total
      const cost = calc.calculateDetailed?.("claude-opus-4-6", {
        inputTokens: 1000,
        outputTokens: 0,
        cachedInputTokens: 1000,
      });
      // Should be 1000 * cachedInput rate, 0 regular input
      expect(cost).toBeCloseTo(1000 * 1.5e-6, 10);
    });

    // --- Cache creation tokens ---

    test("cache creation tokens use premium rate", () => {
      const calc = createCostCalculator();
      // claude-opus-4-6: cacheCreation 18.75e-6 (1.25x of 15e-6)
      const cost = calc.calculateDetailed?.("claude-opus-4-6", {
        inputTokens: 1000,
        outputTokens: 0,
        cacheCreationTokens: 1000,
      });
      expect(cost).toBeCloseTo(1000 * 18.75e-6, 10);
    });

    // --- Reasoning/thinking tokens ---

    test("reasoning tokens billed at output rate", () => {
      const calc = createCostCalculator();
      // gpt-4o: output 10e-6
      const cost = calc.calculateDetailed?.("gpt-4o", {
        inputTokens: 0,
        outputTokens: 500,
        reasoningTokens: 300,
      });
      // 200 regular output + 300 reasoning, all at output rate
      expect(cost).toBeCloseTo(500 * 10e-6, 10);
    });

    test("reasoning tokens as hidden cost multiplier", () => {
      const calc = createCostCalculator();
      // 100 visible output + 10000 reasoning = 10100 output tokens billed
      const cost = calc.calculateDetailed?.("gpt-4o", {
        inputTokens: 100,
        outputTokens: 10100,
        reasoningTokens: 10000,
      });
      const naiveExpected = 100 * 2.5e-6 + 10100 * 10e-6;
      expect(cost).toBeCloseTo(naiveExpected, 10);
    });

    // --- Model aliasing ---

    test("dated model resolves via alias fallback", () => {
      const calc = createCostCalculator();
      const cost = calc.calculateDetailed?.("claude-sonnet-4-6-20260414", {
        inputTokens: 1000,
        outputTokens: 500,
      });
      // Should resolve to claude-sonnet-4-6 pricing
      expect(cost).toBeGreaterThan(0);
    });

    test("unknown model returns 0 in detailed mode", () => {
      const calc = createCostCalculator();
      const cost = calc.calculateDetailed?.("unknown-model", {
        inputTokens: 1000,
        outputTokens: 500,
      });
      expect(cost).toBe(0);
    });

    // --- Zero-cost / degenerate cases ---

    test("zero tokens returns 0", () => {
      const calc = createCostCalculator();
      const cost = calc.calculateDetailed?.("gpt-4o", {
        inputTokens: 0,
        outputTokens: 0,
      });
      expect(cost).toBe(0);
    });

    test("all tokens cached returns only cached cost", () => {
      const calc = createCostCalculator();
      const cost = calc.calculateDetailed?.("gpt-4o", {
        inputTokens: 500,
        outputTokens: 0,
        cachedInputTokens: 500,
      });
      // gpt-4o: cachedInput 1.25e-6
      expect(cost).toBeCloseTo(500 * 1.25e-6, 10);
    });

    // --- Floating-point accumulation ---

    test("large token counts maintain precision", () => {
      const calc = createCostCalculator();
      const cost = calc.calculateDetailed?.("gpt-4o", {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      });
      const expected = 1_000_000 * 2.5e-6 + 500_000 * 10e-6;
      expect(cost).toBeCloseTo(expected, 6);
    });

    // --- Fallback when cachedInput pricing absent ---

    test("falls back to input rate when cachedInput pricing undefined", () => {
      const calc = createCostCalculator({
        pricingOverrides: {
          "no-cache-model": { input: 5e-6, output: 10e-6 },
        },
      });
      const cost = calc.calculateDetailed?.("no-cache-model", {
        inputTokens: 1000,
        outputTokens: 0,
        cachedInputTokens: 500,
      });
      // cachedInput falls back to input rate (5e-6)
      expect(cost).toBeCloseTo(1000 * 5e-6, 10);
    });
  });
});
