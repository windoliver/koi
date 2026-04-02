/**
 * Config resolution and validation tests.
 */

import { describe, expect, it } from "bun:test";
import { resolveConfig, validateResolvedConfig } from "./resolve-config.js";
import { COMPACTION_DEFAULTS } from "./types.js";

describe("resolveConfig", () => {
  it("applies all defaults when called with no args", () => {
    const result = resolveConfig();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contextWindowSize).toBe(COMPACTION_DEFAULTS.contextWindowSize);
    expect(result.value.preserveRecent).toBe(COMPACTION_DEFAULTS.preserveRecent);
    expect(result.value.micro.triggerFraction).toBe(COMPACTION_DEFAULTS.micro.triggerFraction);
    expect(result.value.micro.targetFraction).toBe(COMPACTION_DEFAULTS.micro.targetFraction);
    expect(result.value.micro.strategy).toBe(COMPACTION_DEFAULTS.micro.strategy);
    expect(result.value.full.triggerFraction).toBe(COMPACTION_DEFAULTS.full.triggerFraction);
    expect(result.value.full.maxSummaryTokens).toBe(COMPACTION_DEFAULTS.full.maxSummaryTokens);
    expect(result.value.backoff.initialSkip).toBe(COMPACTION_DEFAULTS.backoff.initialSkip);
    expect(result.value.backoff.cap).toBe(COMPACTION_DEFAULTS.backoff.cap);
    expect(result.value.replacement.maxResultTokens).toBe(
      COMPACTION_DEFAULTS.replacement.maxResultTokens,
    );
    expect(result.value.replacement.maxMessageTokens).toBe(
      COMPACTION_DEFAULTS.replacement.maxMessageTokens,
    );
    expect(result.value.replacement.previewChars).toBe(
      COMPACTION_DEFAULTS.replacement.previewChars,
    );
  });

  it("applies partial overrides", () => {
    const result = resolveConfig({ contextWindowSize: 100_000, micro: { triggerFraction: 0.4 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contextWindowSize).toBe(100_000);
    expect(result.value.micro.triggerFraction).toBe(0.4);
    // Other fields still at defaults
    expect(result.value.full.triggerFraction).toBe(COMPACTION_DEFAULTS.full.triggerFraction);
  });

  it("returns errors for invalid fractions", () => {
    const result = resolveConfig({ micro: { triggerFraction: 1.5 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("micro.triggerFraction"))).toBe(true);
  });

  it("returns errors for negative contextWindowSize", () => {
    const result = resolveConfig({ contextWindowSize: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("contextWindowSize"))).toBe(true);
  });

  it("returns errors when micro.targetFraction >= micro.triggerFraction", () => {
    const result = resolveConfig({ micro: { triggerFraction: 0.4, targetFraction: 0.6 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("targetFraction") && e.includes("less than"))).toBe(
      true,
    );
  });

  it("returns errors when micro.triggerFraction > full.triggerFraction", () => {
    const result = resolveConfig({
      micro: { triggerFraction: 0.8 },
      full: { triggerFraction: 0.6 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("must not exceed"))).toBe(true);
  });

  it("returns errors when backoff.cap < backoff.initialSkip", () => {
    const result = resolveConfig({ backoff: { initialSkip: 10, cap: 5 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("backoff.cap"))).toBe(true);
  });

  it("returns errors when replacement.maxMessageTokens < maxResultTokens", () => {
    const result = resolveConfig({
      replacement: { maxResultTokens: 20_000, maxMessageTokens: 10_000 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("maxMessageTokens"))).toBe(true);
  });

  it("returns errors for NaN values", () => {
    const result = resolveConfig({ contextWindowSize: NaN });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("contextWindowSize"))).toBe(true);
  });

  it("collects multiple errors at once", () => {
    const result = resolveConfig({
      contextWindowSize: -1,
      micro: { triggerFraction: 2, targetFraction: -1 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("accepts valid custom config", () => {
    const result = resolveConfig({
      contextWindowSize: 128_000,
      preserveRecent: 6,
      micro: { triggerFraction: 0.4, targetFraction: 0.25, strategy: "summarize" },
      full: { triggerFraction: 0.7, maxSummaryTokens: 2000 },
      backoff: { initialSkip: 2, cap: 16 },
      replacement: { maxResultTokens: 10_000, maxMessageTokens: 40_000, previewChars: 1024 },
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateResolvedConfig", () => {
  it("returns empty array for valid default config", () => {
    const result = resolveConfig();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateResolvedConfig(result.value)).toEqual([]);
  });
});
