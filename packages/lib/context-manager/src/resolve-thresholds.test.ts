import { describe, expect, it } from "bun:test";
import { resolveThresholds } from "./resolve-thresholds.js";
import { COMPACTION_DEFAULTS } from "./types.js";

describe("resolveThresholds", () => {
  it("falls back to COMPACTION_DEFAULTS when config is undefined", () => {
    expect(resolveThresholds(undefined)).toEqual({
      contextWindow: COMPACTION_DEFAULTS.contextWindowSize,
      softTriggerFraction: COMPACTION_DEFAULTS.micro.triggerFraction,
      hardTriggerFraction: COMPACTION_DEFAULTS.full.triggerFraction,
      prunePreserveLastK: COMPACTION_DEFAULTS.prunePreserveLastK,
    });
  });

  it("uses contextWindowSize when no modelId", () => {
    expect(resolveThresholds({ contextWindowSize: 300_000 })).toEqual({
      contextWindow: 300_000,
      softTriggerFraction: COMPACTION_DEFAULTS.micro.triggerFraction,
      hardTriggerFraction: COMPACTION_DEFAULTS.full.triggerFraction,
      prunePreserveLastK: COMPACTION_DEFAULTS.prunePreserveLastK,
    });
  });

  it("resolves from model-registry for known models", () => {
    expect(resolveThresholds({ modelId: "claude-opus-4-6" }).contextWindow).toBe(1_000_000);
  });

  it("per-model policy overrides take precedence over globalPolicy", () => {
    const resolved = resolveThresholds(
      {
        modelId: "gpt-4o",
        globalPolicy: {
          softTriggerFraction: 0.4,
          hardTriggerFraction: 0.7,
          prunePreserveLastK: 2,
        },
        perModelPolicy: {
          "gpt-4o": {
            softTriggerFraction: 0.3,
            hardTriggerFraction: 0.6,
            prunePreserveLastK: 5,
          },
        },
      },
      "gpt-4o",
    );

    expect(resolved.softTriggerFraction).toBe(0.3);
    expect(resolved.hardTriggerFraction).toBe(0.6);
    expect(resolved.prunePreserveLastK).toBe(5);
  });

  it("globalPolicy overrides micro/full fractions", () => {
    const resolved = resolveThresholds({
      globalPolicy: {
        softTriggerFraction: 0.45,
        hardTriggerFraction: 0.8,
      },
      micro: { triggerFraction: 0.4 },
      full: { triggerFraction: 0.7 },
    });

    expect(resolved.softTriggerFraction).toBe(0.45);
    expect(resolved.hardTriggerFraction).toBe(0.8);
  });

  it("modelWindowOverrides override registry", () => {
    expect(
      resolveThresholds({
        modelId: "claude-opus-4-6",
        modelWindowOverrides: { "claude-opus-4-6": 500_000 },
      }).contextWindow,
    ).toBe(500_000);
  });
});
