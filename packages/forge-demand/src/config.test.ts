import { describe, expect, it } from "bun:test";
import { DEFAULT_FORGE_BUDGET } from "@koi/core";
import { DEFAULT_CONFIDENCE_WEIGHTS } from "./confidence.js";
import {
  createDefaultForgeDemandConfig,
  DEFAULT_FORGE_DEMAND_CONFIG,
  validateForgeDemandConfig,
} from "./config.js";

describe("validateForgeDemandConfig", () => {
  it("validates a minimal valid config", () => {
    const result = validateForgeDemandConfig({ budget: {} });
    expect(result.ok).toBe(true);
  });

  it("rejects null config", () => {
    const result = validateForgeDemandConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("non-null object");
    }
  });

  it("rejects undefined config", () => {
    const result = validateForgeDemandConfig(undefined);
    expect(result.ok).toBe(false);
  });

  it("rejects non-object config", () => {
    const result = validateForgeDemandConfig("not an object");
    expect(result.ok).toBe(false);
  });

  it("validates budget fields", () => {
    const result = validateForgeDemandConfig({
      budget: {
        maxForgesPerSession: 10,
        computeTimeBudgetMs: 60_000,
        demandThreshold: 0.5,
        cooldownMs: 10_000,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.budget.maxForgesPerSession).toBe(10);
      expect(result.value.budget.demandThreshold).toBe(0.5);
    }
  });

  it("rejects invalid demandThreshold (> 1)", () => {
    const result = validateForgeDemandConfig({
      budget: { demandThreshold: 1.5 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid demandThreshold (< 0)", () => {
    const result = validateForgeDemandConfig({
      budget: { demandThreshold: -0.1 },
    });
    expect(result.ok).toBe(false);
  });

  it("validates heuristic thresholds", () => {
    const result = validateForgeDemandConfig({
      budget: {},
      heuristics: {
        repeatedFailureCount: 5,
        capabilityGapOccurrences: 3,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.heuristics?.repeatedFailureCount).toBe(5);
      expect(result.value.heuristics?.capabilityGapOccurrences).toBe(3);
    }
  });

  it("rejects invalid heuristic thresholds", () => {
    const result = validateForgeDemandConfig({
      budget: {},
      heuristics: { repeatedFailureCount: -1 },
    });
    expect(result.ok).toBe(false);
  });

  it("validates healthTracker duck-type", () => {
    const result = validateForgeDemandConfig({
      budget: {},
      healthTracker: {
        getHealthSnapshot: () => undefined,
        isQuarantined: () => false,
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects invalid healthTracker", () => {
    const result = validateForgeDemandConfig({
      budget: {},
      healthTracker: { invalid: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("getHealthSnapshot");
    }
  });

  it("validates onDemand callback", () => {
    const result = validateForgeDemandConfig({
      budget: {},
      onDemand: () => {},
    });
    expect(result.ok).toBe(true);
  });

  it("rejects invalid onDemand", () => {
    const result = validateForgeDemandConfig({
      budget: {},
      onDemand: "not a function",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid clock", () => {
    const result = validateForgeDemandConfig({
      budget: {},
      clock: 42,
    });
    expect(result.ok).toBe(false);
  });

  it("validates capabilityGapPatterns", () => {
    const result = validateForgeDemandConfig({
      budget: {},
      capabilityGapPatterns: [/test/i],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects non-RegExp capabilityGapPatterns", () => {
    const result = validateForgeDemandConfig({
      budget: {},
      capabilityGapPatterns: ["not a regex"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("RegExp");
    }
  });

  it("rejects non-array capabilityGapPatterns", () => {
    const result = validateForgeDemandConfig({
      budget: {},
      capabilityGapPatterns: "not an array",
    });
    expect(result.ok).toBe(false);
  });

  it("applies defaults for missing fields", () => {
    const result = validateForgeDemandConfig({ budget: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.budget.maxForgesPerSession).toBe(
        DEFAULT_FORGE_BUDGET.maxForgesPerSession,
      );
      expect(result.value.budget.demandThreshold).toBe(DEFAULT_FORGE_BUDGET.demandThreshold);
      expect(result.value.maxPendingSignals).toBe(10);
    }
  });
});

describe("createDefaultForgeDemandConfig", () => {
  it("returns default config with no overrides", () => {
    const config = createDefaultForgeDemandConfig();
    expect(config).toEqual(DEFAULT_FORGE_DEMAND_CONFIG);
  });

  it("merges budget overrides", () => {
    const config = createDefaultForgeDemandConfig({
      budget: { ...DEFAULT_FORGE_BUDGET, maxForgesPerSession: 10 },
    });
    expect(config.budget.maxForgesPerSession).toBe(10);
    expect(config.budget.cooldownMs).toBe(DEFAULT_FORGE_BUDGET.cooldownMs);
  });

  it("merges heuristic overrides", () => {
    const config = createDefaultForgeDemandConfig({
      heuristics: { repeatedFailureCount: 5 },
    });
    expect(config.heuristics?.repeatedFailureCount).toBe(5);
    expect(config.heuristics?.confidenceWeights).toEqual(DEFAULT_CONFIDENCE_WEIGHTS);
  });
});
