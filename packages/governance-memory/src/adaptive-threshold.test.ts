/**
 * Tests for adaptive threshold — decay on violations, recovery on clean evals.
 */

import { describe, expect, test } from "bun:test";
import { adjustThreshold, createAdaptiveThreshold } from "./adaptive-threshold.js";
import type { AdaptiveThresholdConfig } from "./types.js";

const BASE_CONFIG: AdaptiveThresholdConfig = {
  baseValue: 100,
  decayRate: 0.9,
  recoveryRate: 1.02,
  floor: 10,
  ceiling: 200,
};

describe("createAdaptiveThreshold", () => {
  test("initial value equals baseValue", () => {
    const t = createAdaptiveThreshold(BASE_CONFIG);
    expect(t.currentValue).toBe(100);
    expect(t.baseValue).toBe(100);
  });

  test("preserves all config values", () => {
    const t = createAdaptiveThreshold(BASE_CONFIG);
    expect(t.decayRate).toBe(0.9);
    expect(t.recoveryRate).toBe(1.02);
    expect(t.floor).toBe(10);
    expect(t.ceiling).toBe(200);
  });
});

describe("adjustThreshold", () => {
  test("decay on violation — value * decayRate", () => {
    const t = createAdaptiveThreshold(BASE_CONFIG);
    const adjusted = adjustThreshold(t, true);
    expect(adjusted.currentValue).toBe(90); // 100 * 0.9
  });

  test("recovery on clean — value * recoveryRate", () => {
    const t = createAdaptiveThreshold(BASE_CONFIG);
    const adjusted = adjustThreshold(t, false);
    expect(adjusted.currentValue).toBe(102); // 100 * 1.02
  });

  test("respects floor — cannot decay below floor", () => {
    const t = createAdaptiveThreshold({ ...BASE_CONFIG, baseValue: 11 });
    const adjusted = adjustThreshold(t, true); // 11 * 0.9 = 9.9 → clamped to 10
    expect(adjusted.currentValue).toBe(10);
  });

  test("respects ceiling — cannot recover above ceiling", () => {
    const t = createAdaptiveThreshold({ ...BASE_CONFIG, baseValue: 199 });
    const adjusted = adjustThreshold(t, false); // 199 * 1.02 = 202.98 → clamped to 200
    expect(adjusted.currentValue).toBe(200);
  });

  test("immutability — original threshold unchanged", () => {
    const original = createAdaptiveThreshold(BASE_CONFIG);
    const adjusted = adjustThreshold(original, true);
    expect(original.currentValue).toBe(100); // Unchanged
    expect(adjusted.currentValue).toBe(90);
    expect(original).not.toBe(adjusted);
  });

  test("multiple decays compound correctly", () => {
    const t0 = createAdaptiveThreshold(BASE_CONFIG);
    const t1 = adjustThreshold(t0, true); // 100 * 0.9 = 90
    const t2 = adjustThreshold(t1, true); // 90 * 0.9 = 81
    const t3 = adjustThreshold(t2, true); // 81 * 0.9 = 72.9
    expect(t1.currentValue).toBe(90);
    expect(t2.currentValue).toBe(81);
    expect(t3.currentValue).toBeCloseTo(72.9);
  });

  test("recovery after decay — partial restoration", () => {
    const t0 = createAdaptiveThreshold(BASE_CONFIG);
    const t1 = adjustThreshold(t0, true); // 100 * 0.9 = 90
    const t2 = adjustThreshold(t1, false); // 90 * 1.02 = 91.8
    expect(t2.currentValue).toBeCloseTo(91.8);
  });
});
