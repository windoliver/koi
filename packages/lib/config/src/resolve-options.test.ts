import { describe, expect, test } from "bun:test";
import type { KoiConfig } from "@koi/core/config";
import { resolveKoiOptions } from "./resolve-options.js";

const SAMPLE_CONFIG: KoiConfig = {
  logLevel: "info",
  telemetry: { enabled: true, endpoint: "https://t.example.com", sampleRate: 0.5 },
  limits: { maxTurns: 25, maxDurationMs: 300_000, maxTokens: 100_000 },
  loopDetection: { enabled: true, windowSize: 8, threshold: 3 },
  spawn: { maxDepth: 3, maxFanOut: 5, maxTotalProcesses: 20 },
  forge: {
    enabled: true,
    maxForgeDepth: 1,
    maxForgesPerSession: 5,
    defaultScope: "agent",
    defaultPolicy: "sandbox",
  },
  modelRouter: {
    strategy: "fallback",
    targets: [{ provider: "anthropic", model: "claude-sonnet-4-20250514" }],
  },
  features: { experimentalX: true },
};

describe("resolveKoiOptions", () => {
  test("maps logLevel directly", () => {
    const opts = resolveKoiOptions(SAMPLE_CONFIG);
    expect(opts.logLevel).toBe("info");
  });

  test("flattens telemetry fields", () => {
    const opts = resolveKoiOptions(SAMPLE_CONFIG);
    expect(opts.telemetryEnabled).toBe(true);
    expect(opts.telemetryEndpoint).toBe("https://t.example.com");
    expect(opts.telemetrySampleRate).toBe(0.5);
  });

  test("passes through section objects", () => {
    const opts = resolveKoiOptions(SAMPLE_CONFIG);
    expect(opts.limits).toEqual(SAMPLE_CONFIG.limits);
    expect(opts.loopDetection).toEqual(SAMPLE_CONFIG.loopDetection);
    expect(opts.spawn).toEqual(SAMPLE_CONFIG.spawn);
    expect(opts.forge).toEqual(SAMPLE_CONFIG.forge);
  });

  test("maps modelRouter fields", () => {
    const opts = resolveKoiOptions(SAMPLE_CONFIG);
    expect(opts.modelRouterStrategy).toBe("fallback");
    expect(opts.modelRouterTargets).toEqual(SAMPLE_CONFIG.modelRouter.targets);
  });

  test("passes features through", () => {
    const opts = resolveKoiOptions(SAMPLE_CONFIG);
    expect(opts.features).toEqual({ experimentalX: true });
  });

  test("handles undefined optional telemetry fields", () => {
    const config: KoiConfig = {
      ...SAMPLE_CONFIG,
      telemetry: { enabled: false },
    };
    const opts = resolveKoiOptions(config);
    expect(opts.telemetryEnabled).toBe(false);
    expect(opts.telemetryEndpoint).toBeUndefined();
    expect(opts.telemetrySampleRate).toBeUndefined();
  });
});
