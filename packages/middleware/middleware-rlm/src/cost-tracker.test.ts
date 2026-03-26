import { describe, expect, test } from "bun:test";
import type { CostEstimator } from "./cost-tracker.js";
import { createCostTracker } from "./cost-tracker.js";

describe("createCostTracker", () => {
  /** Simple estimator: $0.01 per 1k input tokens + $0.03 per 1k output tokens. */
  const simpleEstimator: CostEstimator = (
    _modelId: string,
    inputTokens: number,
    outputTokens: number,
  ): number => (inputTokens / 1000) * 0.01 + (outputTokens / 1000) * 0.03;

  test("add accumulates cost via estimator", () => {
    const tracker = createCostTracker(simpleEstimator);
    tracker.add("gpt-4", 1000, 0); // $0.01
    expect(tracker.total()).toBeCloseTo(0.01, 6);
    tracker.add("gpt-4", 0, 1000); // $0.03
    expect(tracker.total()).toBeCloseTo(0.04, 6);
  });

  test("total returns cumulative cost", () => {
    const tracker = createCostTracker(simpleEstimator);
    tracker.add("gpt-4", 2000, 1000); // $0.02 + $0.03 = $0.05
    tracker.add("gpt-4", 3000, 2000); // $0.03 + $0.06 = $0.09
    expect(tracker.total()).toBeCloseTo(0.14, 6);
  });

  test("remaining returns max - total clamped at 0", () => {
    const tracker = createCostTracker(simpleEstimator);
    tracker.add("gpt-4", 1000, 0); // $0.01
    expect(tracker.remaining(1.0)).toBeCloseTo(0.99, 6);
  });

  test("remaining returns 0 when total exceeds maxCostUsd", () => {
    const tracker = createCostTracker(simpleEstimator);
    tracker.add("gpt-4", 100_000, 100_000); // $1.00 + $3.00 = $4.00
    expect(tracker.remaining(1.0)).toBe(0);
  });

  test("exceeded returns true when total >= maxCostUsd", () => {
    const tracker = createCostTracker(simpleEstimator);
    tracker.add("gpt-4", 100_000, 0); // $1.00
    expect(tracker.exceeded(1.0)).toBe(true);
  });

  test("exceeded returns false when under budget", () => {
    const tracker = createCostTracker(simpleEstimator);
    tracker.add("gpt-4", 1000, 0); // $0.01
    expect(tracker.exceeded(1.0)).toBe(false);
  });

  test("handles zero-cost estimator", () => {
    const zeroCost: CostEstimator = (): number => 0;
    const tracker = createCostTracker(zeroCost);
    tracker.add("gpt-4", 50_000, 50_000);
    tracker.add("gpt-4", 50_000, 50_000);
    expect(tracker.total()).toBe(0);
    expect(tracker.remaining(10.0)).toBe(10.0);
    expect(tracker.exceeded(10.0)).toBe(false);
  });

  test("multiple model IDs tracked correctly", () => {
    const perModelEstimator: CostEstimator = (
      modelId: string,
      inputTokens: number,
      outputTokens: number,
    ): number => {
      const rate = modelId === "expensive" ? 0.1 : 0.01;
      return ((inputTokens + outputTokens) / 1000) * rate;
    };
    const tracker = createCostTracker(perModelEstimator);
    tracker.add("expensive", 1000, 0); // $0.10
    tracker.add("cheap", 1000, 0); // $0.01
    expect(tracker.total()).toBeCloseTo(0.11, 6);
  });
});
