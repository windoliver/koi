import { describe, expect, test } from "bun:test";
import { KoiRuntimeError } from "@koi/errors";
import { createFlatRateCostCalculator } from "./cost-calculator.js";

describe("createFlatRateCostCalculator", () => {
  const pricing = {
    "gpt-4o-mini": { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  } as const;

  test("computes cost per 1M tokens", () => {
    const calc = createFlatRateCostCalculator(pricing);
    const cost = calc.calculate("gpt-4o-mini", 1_000_000, 500_000);
    expect(cost).toBeCloseTo(0.15 + 0.3, 10);
  });

  test("zero tokens → zero cost", () => {
    const calc = createFlatRateCostCalculator(pricing);
    expect(calc.calculate("gpt-4o-mini", 0, 0)).toBe(0);
  });

  test("unknown model throws VALIDATION", () => {
    const calc = createFlatRateCostCalculator(pricing);
    try {
      calc.calculate("missing", 1, 1);
      expect.unreachable();
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      const err = e as KoiRuntimeError;
      expect(err.code).toBe("VALIDATION");
    }
  });

  test("negative tokens throw VALIDATION", () => {
    const calc = createFlatRateCostCalculator(pricing);
    try {
      calc.calculate("gpt-4o-mini", -1, 0);
      expect.unreachable();
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      const err = e as KoiRuntimeError;
      expect(err.code).toBe("VALIDATION");
    }

    try {
      calc.calculate("gpt-4o-mini", 0, -1);
      expect.unreachable();
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      const err = e as KoiRuntimeError;
      expect(err.code).toBe("VALIDATION");
    }
  });

  test("non-finite tokens throw VALIDATION", () => {
    const calc = createFlatRateCostCalculator(pricing);
    try {
      calc.calculate("gpt-4o-mini", Number.NaN, 0);
      expect.unreachable();
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      const err = e as KoiRuntimeError;
      expect(err.code).toBe("VALIDATION");
    }

    try {
      calc.calculate("gpt-4o-mini", Number.POSITIVE_INFINITY, 0);
      expect.unreachable();
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      const err = e as KoiRuntimeError;
      expect(err.code).toBe("VALIDATION");
    }
  });
});
