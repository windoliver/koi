import { describe, expect, test } from "bun:test";
import { validatePayConfig } from "./config.js";
import { createDefaultCostCalculator, createInMemoryBudgetTracker } from "./tracker.js";

describe("validatePayConfig", () => {
  const tracker = createInMemoryBudgetTracker();
  const calculator = createDefaultCostCalculator();

  test("accepts valid config", () => {
    const result = validatePayConfig({ tracker, calculator, budget: 10 });
    expect(result.ok).toBe(true);
  });

  test("rejects null config", () => {
    const result = validatePayConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects undefined config", () => {
    const result = validatePayConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects config without tracker", () => {
    const result = validatePayConfig({ calculator, budget: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("tracker");
  });

  test("rejects config without calculator", () => {
    const result = validatePayConfig({ tracker, budget: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("calculator");
  });

  test("rejects config without budget", () => {
    const result = validatePayConfig({ tracker, calculator });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("budget");
  });

  test("rejects negative budget", () => {
    const result = validatePayConfig({ tracker, calculator, budget: -1 });
    expect(result.ok).toBe(false);
  });

  test("accepts zero budget", () => {
    const result = validatePayConfig({ tracker, calculator, budget: 0 });
    expect(result.ok).toBe(true);
  });

  test("rejects non-array alertThresholds", () => {
    const result = validatePayConfig({ tracker, calculator, budget: 10, alertThresholds: "bad" });
    expect(result.ok).toBe(false);
  });

  test("rejects threshold above 1", () => {
    const result = validatePayConfig({ tracker, calculator, budget: 10, alertThresholds: [1.5] });
    expect(result.ok).toBe(false);
  });

  test("rejects threshold below 0", () => {
    const result = validatePayConfig({
      tracker,
      calculator,
      budget: 10,
      alertThresholds: [-0.1],
    });
    expect(result.ok).toBe(false);
  });

  test("accepts valid thresholds", () => {
    const result = validatePayConfig({
      tracker,
      calculator,
      budget: 10,
      alertThresholds: [0.5, 0.8, 0.95],
    });
    expect(result.ok).toBe(true);
  });

  test("all errors are non-retryable", () => {
    const result = validatePayConfig(null);
    if (!result.ok) expect(result.error.retryable).toBe(false);
  });
});
