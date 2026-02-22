import { describe, expect, test } from "bun:test";
import type { CostEntry } from "./tracker.js";
import { createDefaultCostCalculator, createInMemoryBudgetTracker } from "./tracker.js";

describe("InMemoryBudgetTracker", () => {
  const makeCostEntry = (costUsd: number, model = "test-model"): CostEntry => ({
    inputTokens: 100,
    outputTokens: 50,
    model,
    costUsd,
    timestamp: Date.now(),
  });

  test("record and totalSpend round-trip", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("s1", makeCostEntry(0.5));
    const total = await tracker.totalSpend("s1");
    expect(total).toBe(0.5);
  });

  test("empty session has zero spend", async () => {
    const tracker = createInMemoryBudgetTracker();
    const total = await tracker.totalSpend("s1");
    expect(total).toBe(0);
  });

  test("remaining calculation", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("s1", makeCostEntry(3));
    const rem = await tracker.remaining("s1", 10);
    expect(rem).toBe(7);
  });

  test("remaining never goes below zero", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("s1", makeCostEntry(15));
    const rem = await tracker.remaining("s1", 10);
    expect(rem).toBe(0);
  });

  test("multiple sessions are isolated", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("s1", makeCostEntry(5));
    await tracker.record("s2", makeCostEntry(3));
    expect(await tracker.totalSpend("s1")).toBe(5);
    expect(await tracker.totalSpend("s2")).toBe(3);
  });

  test("multiple records accumulate", async () => {
    const tracker = createInMemoryBudgetTracker();
    await tracker.record("s1", makeCostEntry(1));
    await tracker.record("s1", makeCostEntry(2));
    await tracker.record("s1", makeCostEntry(3));
    expect(await tracker.totalSpend("s1")).toBe(6);
  });
});

describe("DefaultCostCalculator", () => {
  test("calculates cost with default rates", () => {
    const calc = createDefaultCostCalculator();
    const cost = calc.calculate("gpt-4", 1000, 500);
    // 1000 * 0.000003 + 500 * 0.000015 = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  test("uses custom model rates", () => {
    const calc = createDefaultCostCalculator({
      "cheap-model": { input: 0.000001, output: 0.000002 },
    });
    const cost = calc.calculate("cheap-model", 1000, 1000);
    // 1000 * 0.000001 + 1000 * 0.000002 = 0.001 + 0.002 = 0.003
    expect(cost).toBeCloseTo(0.003, 6);
  });

  test("falls back to default rates for unknown models", () => {
    const calc = createDefaultCostCalculator({
      "known-model": { input: 0.000001, output: 0.000001 },
    });
    const cost = calc.calculate("unknown-model", 1000, 500);
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  test("zero tokens produce zero cost", () => {
    const calc = createDefaultCostCalculator();
    expect(calc.calculate("gpt-4", 0, 0)).toBe(0);
  });
});
