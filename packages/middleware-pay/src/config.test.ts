import { describe, expect, test } from "bun:test";
import { validatePayConfig } from "./config.js";
import { createDefaultCostCalculator, createInMemoryPayLedger } from "./tracker.js";

describe("validatePayConfig", () => {
  const ledger = createInMemoryPayLedger(10);
  const calculator = createDefaultCostCalculator();

  test("accepts valid config", () => {
    const result = validatePayConfig({ ledger, calculator, budget: 10 });
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

  test("rejects config without ledger", () => {
    const result = validatePayConfig({ calculator, budget: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("ledger");
  });

  test("rejects config without calculator", () => {
    const result = validatePayConfig({ ledger, budget: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("calculator");
  });

  test("rejects config without budget", () => {
    const result = validatePayConfig({ ledger, calculator });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("budget");
  });

  test("rejects negative budget", () => {
    const result = validatePayConfig({ ledger, calculator, budget: -1 });
    expect(result.ok).toBe(false);
  });

  test("accepts zero budget", () => {
    const result = validatePayConfig({ ledger, calculator, budget: 0 });
    expect(result.ok).toBe(true);
  });

  test("rejects non-array alertThresholds", () => {
    const result = validatePayConfig({ ledger, calculator, budget: 10, alertThresholds: "bad" });
    expect(result.ok).toBe(false);
  });

  test("rejects threshold above 1", () => {
    const result = validatePayConfig({ ledger, calculator, budget: 10, alertThresholds: [1.5] });
    expect(result.ok).toBe(false);
  });

  test("rejects threshold below 0", () => {
    const result = validatePayConfig({ ledger, calculator, budget: 10, alertThresholds: [-0.1] });
    expect(result.ok).toBe(false);
  });

  test("accepts valid thresholds", () => {
    const result = validatePayConfig({
      ledger,
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
