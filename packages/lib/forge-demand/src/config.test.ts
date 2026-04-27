import { describe, expect, it } from "bun:test";
import {
  createDefaultForgeDemandConfig,
  DEFAULT_FORGE_DEMAND_CONFIG,
  validateForgeDemandConfig,
} from "./config.js";

describe("validateForgeDemandConfig", () => {
  it("accepts an empty object and resolves defaults", () => {
    const result = validateForgeDemandConfig({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.budget.demandThreshold).toBe(
        DEFAULT_FORGE_DEMAND_CONFIG.budget.demandThreshold,
      );
      expect(result.value.maxPendingSignals).toBe(10);
    }
  });

  it("rejects non-object input", () => {
    const result = validateForgeDemandConfig(null);
    expect(result.ok).toBe(false);
  });

  it("rejects non-RegExp capabilityGapPatterns", () => {
    const result = validateForgeDemandConfig({ capabilityGapPatterns: ["not a regex"] });
    expect(result.ok).toBe(false);
  });

  it("merges overrides with defaults", () => {
    const cfg = createDefaultForgeDemandConfig({
      budget: {
        ...DEFAULT_FORGE_DEMAND_CONFIG.budget,
        demandThreshold: 0.42,
      },
    });
    expect(cfg.budget.demandThreshold).toBe(0.42);
    expect(cfg.budget.cooldownMs).toBe(DEFAULT_FORGE_DEMAND_CONFIG.budget.cooldownMs);
  });
});
