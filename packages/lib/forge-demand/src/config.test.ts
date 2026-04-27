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

  it("F79: preserves acceptLegacySingleArgHealthTracker through the helper", () => {
    // Reviewer F79: validation supports the legacy-arity opt-in but the
    // factory previously dropped the field. A caller doing the natural
    // `createDefaultForgeDemandConfig({ healthTracker, acceptLegacy...:
    // true })` would get back a config that validation then rejects.
    const legacyTracker = {
      // Single-arg shape — the typical legacy signature the opt-in was
      // designed for.
      getSnapshot: (_toolId: string) => undefined,
    };
    const cfg = createDefaultForgeDemandConfig({
      healthTracker: legacyTracker,
      acceptLegacySingleArgHealthTracker: true,
    });
    expect(cfg.acceptLegacySingleArgHealthTracker).toBe(true);
    // And the resulting config must validate cleanly — the whole point
    // of the opt-in path.
    const result = validateForgeDemandConfig(cfg);
    expect(result.ok).toBe(true);
  });
});
