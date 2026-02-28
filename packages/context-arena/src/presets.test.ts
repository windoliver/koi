import { describe, expect, test } from "bun:test";
import { computePresetBudget, PRESET_SPECS } from "./presets.js";
import type { ContextArenaPreset } from "./types.js";

const WINDOW_SIZES = [50_000, 100_000, 200_000, 500_000, 1_000_000] as const;
const PRESET_NAMES: readonly ContextArenaPreset[] = ["conservative", "balanced", "aggressive"];

describe("PRESET_SPECS", () => {
  test("all presets have editingTriggerFraction < triggerFraction", () => {
    for (const name of PRESET_NAMES) {
      const spec = PRESET_SPECS[name];
      expect(spec.editingTriggerFraction).toBeLessThan(spec.triggerFraction);
    }
  });

  test("conservative <= balanced <= aggressive trigger fractions", () => {
    expect(PRESET_SPECS.conservative.triggerFraction).toBeLessThanOrEqual(
      PRESET_SPECS.balanced.triggerFraction,
    );
    expect(PRESET_SPECS.balanced.triggerFraction).toBeLessThanOrEqual(
      PRESET_SPECS.aggressive.triggerFraction,
    );
  });

  test("all spec values are positive", () => {
    for (const name of PRESET_NAMES) {
      const spec = PRESET_SPECS[name];
      expect(spec.triggerFraction).toBeGreaterThan(0);
      expect(spec.softTriggerOffset).toBeGreaterThan(0);
      expect(spec.preserveRecent).toBeGreaterThan(0);
      expect(spec.summaryTokenFraction).toBeGreaterThan(0);
      expect(spec.editingTriggerFraction).toBeGreaterThan(0);
      expect(spec.editingRecentToKeep).toBeGreaterThan(0);
      expect(spec.maxPendingSquashes).toBeGreaterThan(0);
    }
  });
});

describe("computePresetBudget", () => {
  test("softTrigger < hardTrigger for all presets and window sizes", () => {
    for (const name of PRESET_NAMES) {
      for (const windowSize of WINDOW_SIZES) {
        const budget = computePresetBudget(name, windowSize);
        expect(budget.compactorSoftTriggerFraction).toBeLessThan(budget.compactorTriggerFraction);
      }
    }
  });

  test("editingTrigger < compactorTrigger (token count) for all presets and window sizes", () => {
    for (const name of PRESET_NAMES) {
      for (const windowSize of WINDOW_SIZES) {
        const budget = computePresetBudget(name, windowSize);
        const compactorTriggerTokens = budget.compactorTriggerFraction * windowSize;
        expect(budget.editingTriggerTokenCount).toBeLessThan(compactorTriggerTokens);
      }
    }
  });

  test("conservative.trigger <= balanced.trigger <= aggressive.trigger for all window sizes", () => {
    for (const windowSize of WINDOW_SIZES) {
      const c = computePresetBudget("conservative", windowSize);
      const b = computePresetBudget("balanced", windowSize);
      const a = computePresetBudget("aggressive", windowSize);
      expect(c.compactorTriggerFraction).toBeLessThanOrEqual(b.compactorTriggerFraction);
      expect(b.compactorTriggerFraction).toBeLessThanOrEqual(a.compactorTriggerFraction);
    }
  });

  test("all values are positive for all presets and window sizes", () => {
    for (const name of PRESET_NAMES) {
      for (const windowSize of WINDOW_SIZES) {
        const budget = computePresetBudget(name, windowSize);
        expect(budget.compactorTriggerFraction).toBeGreaterThan(0);
        expect(budget.compactorSoftTriggerFraction).toBeGreaterThan(0);
        expect(budget.compactorPreserveRecent).toBeGreaterThan(0);
        expect(budget.compactorMaxSummaryTokens).toBeGreaterThan(0);
        expect(budget.editingTriggerTokenCount).toBeGreaterThan(0);
        expect(budget.editingNumRecentToKeep).toBeGreaterThan(0);
        expect(budget.squashPreserveRecent).toBeGreaterThan(0);
        expect(budget.squashMaxPendingSquashes).toBeGreaterThan(0);
      }
    }
  });

  test("maxSummaryTokens scales with window size", () => {
    for (const name of PRESET_NAMES) {
      const small = computePresetBudget(name, 50_000);
      const large = computePresetBudget(name, 1_000_000);
      expect(large.compactorMaxSummaryTokens).toBeGreaterThan(small.compactorMaxSummaryTokens);
    }
  });

  test("balanced preset at 200K produces expected values", () => {
    const budget = computePresetBudget("balanced", 200_000);
    expect(budget.compactorTriggerFraction).toBe(0.6);
    expect(budget.compactorSoftTriggerFraction).toBe(0.5);
    expect(budget.compactorPreserveRecent).toBe(4);
    expect(budget.compactorMaxSummaryTokens).toBe(1_000);
    expect(budget.editingTriggerTokenCount).toBe(100_000);
    expect(budget.editingNumRecentToKeep).toBe(3);
    expect(budget.squashPreserveRecent).toBe(4);
    expect(budget.squashMaxPendingSquashes).toBe(3);
  });
});
