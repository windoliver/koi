import { describe, expect, test } from "bun:test";
import type { KoiConfig } from "@koi/core";
import { resolveKoiOptions } from "./resolve-options.js";

function makeConfig(overrides?: Partial<KoiConfig>): KoiConfig {
  return {
    logLevel: "info",
    telemetry: { enabled: false },
    limits: { maxTurns: 25, maxDurationMs: 300_000, maxTokens: 100_000 },
    loopDetection: { enabled: true, windowSize: 8, threshold: 3 },
    spawn: { maxDepth: 3, maxFanOut: 5, maxTotalProcesses: 20 },
    forge: {
      enabled: true,
      maxForgeDepth: 1,
      maxForgesPerSession: 5,
      defaultScope: "agent",
      defaultTrustTier: "sandbox",
    },
    modelRouter: {
      strategy: "fallback",
      targets: [{ provider: "openai", model: "gpt-4" }],
    },
    features: {},
    ...overrides,
  };
}

describe("resolveKoiOptions", () => {
  test("maps limits from config", () => {
    const config = makeConfig({
      limits: { maxTurns: 10, maxDurationMs: 60_000, maxTokens: 50_000 },
    });
    const result = resolveKoiOptions(config);
    expect(result.limits).toEqual({ maxTurns: 10, maxDurationMs: 60_000, maxTokens: 50_000 });
  });

  test("maps loop detection from config", () => {
    const config = makeConfig({ loopDetection: { enabled: true, windowSize: 10, threshold: 4 } });
    const result = resolveKoiOptions(config);
    expect(result.loopDetection).toEqual({ windowSize: 10, threshold: 4 });
  });

  test("returns false for loopDetection when disabled", () => {
    const config = makeConfig({ loopDetection: { enabled: false, windowSize: 8, threshold: 3 } });
    const result = resolveKoiOptions(config);
    expect(result.loopDetection).toBe(false);
  });

  test("includes warningThreshold when present", () => {
    const config = makeConfig({
      loopDetection: { enabled: true, windowSize: 8, threshold: 3, warningThreshold: 2 },
    });
    const result = resolveKoiOptions(config);
    expect(result.loopDetection).toEqual({ windowSize: 8, threshold: 3, warningThreshold: 2 });
  });

  test("maps spawn from config", () => {
    const config = makeConfig({ spawn: { maxDepth: 5, maxFanOut: 10, maxTotalProcesses: 50 } });
    const result = resolveKoiOptions(config);
    expect(result.spawn).toEqual({ maxDepth: 5, maxFanOut: 10, maxTotalProcesses: 50 });
  });

  test("includes spawnToolIds when present", () => {
    const config = makeConfig({
      spawn: { maxDepth: 3, maxFanOut: 5, maxTotalProcesses: 20, spawnToolIds: ["forge_agent"] },
    });
    const result = resolveKoiOptions(config);
    expect(result.spawn.spawnToolIds).toEqual(["forge_agent"]);
  });

  test("overrides limits when provided", () => {
    const config = makeConfig();
    const result = resolveKoiOptions(config, {
      limits: { maxTurns: 99, maxDurationMs: 1000, maxTokens: 500 },
    });
    expect(result.limits).toEqual({ maxTurns: 99, maxDurationMs: 1000, maxTokens: 500 });
  });

  test("overrides loopDetection when provided", () => {
    const config = makeConfig();
    const result = resolveKoiOptions(config, { loopDetection: false });
    expect(result.loopDetection).toBe(false);
  });

  test("overrides spawn when provided", () => {
    const config = makeConfig();
    const result = resolveKoiOptions(config, {
      spawn: { maxDepth: 1, maxFanOut: 2, maxTotalProcesses: 5 },
    });
    expect(result.spawn).toEqual({ maxDepth: 1, maxFanOut: 2, maxTotalProcesses: 5 });
  });

  test("uses config values when no overrides", () => {
    const config = makeConfig();
    const result = resolveKoiOptions(config);
    expect(result.limits.maxTurns).toBe(25);
    expect(result.spawn.maxDepth).toBe(3);
  });
});
