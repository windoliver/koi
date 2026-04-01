import { describe, expect, test } from "bun:test";
import type { KoiConfig } from "@koi/core/config";
import { getKoiConfigJsonSchema, validateKoiConfig } from "./schema.js";

const VALID_CONFIG: KoiConfig = {
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
    defaultPolicy: "sandbox",
  },
  modelRouter: {
    strategy: "fallback",
    targets: [{ provider: "default", model: "default" }],
  },
  features: {},
};

describe("validateKoiConfig", () => {
  test("accepts a valid config", () => {
    const result = validateKoiConfig(VALID_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.logLevel).toBe("info");
    }
  });

  test("rejects invalid logLevel", () => {
    const result = validateKoiConfig({ ...VALID_CONFIG, logLevel: "verbose" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects negative maxTurns", () => {
    const result = validateKoiConfig({
      ...VALID_CONFIG,
      limits: { ...VALID_CONFIG.limits, maxTurns: -1 },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects missing required fields", () => {
    const result = validateKoiConfig({ logLevel: "info" });
    expect(result.ok).toBe(false);
  });

  test("accepts optional telemetry fields", () => {
    const result = validateKoiConfig({
      ...VALID_CONFIG,
      telemetry: { enabled: true, endpoint: "https://t.example.com", sampleRate: 0.5 },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects sampleRate > 1", () => {
    const result = validateKoiConfig({
      ...VALID_CONFIG,
      telemetry: { enabled: true, sampleRate: 1.5 },
    });
    expect(result.ok).toBe(false);
  });

  test("accepts optional spawnToolIds", () => {
    const result = validateKoiConfig({
      ...VALID_CONFIG,
      spawn: { ...VALID_CONFIG.spawn, spawnToolIds: ["tool1", "tool2"] },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts optional warningThreshold in loopDetection", () => {
    const result = validateKoiConfig({
      ...VALID_CONFIG,
      loopDetection: { ...VALID_CONFIG.loopDetection, warningThreshold: 2 },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts optional model target fields", () => {
    const result = validateKoiConfig({
      ...VALID_CONFIG,
      modelRouter: {
        strategy: "weighted",
        targets: [{ provider: "anthropic", model: "claude", weight: 0.8, enabled: true }],
      },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts feature flags", () => {
    const result = validateKoiConfig({
      ...VALID_CONFIG,
      features: { experimentalX: true, betaY: false },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.features).toEqual({ experimentalX: true, betaY: false });
    }
  });

  test("error message includes prefix", () => {
    const result = validateKoiConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("KoiConfig validation failed");
    }
  });
});

describe("getKoiConfigJsonSchema", () => {
  test("returns an object with properties", () => {
    const schema = getKoiConfigJsonSchema();
    expect(schema).toBeDefined();
    expect(typeof schema).toBe("object");
    expect(schema.type).toBe("object");
  });

  test("includes all 8 config sections", () => {
    const schema = getKoiConfigJsonSchema();
    const props = schema.properties as Record<string, unknown> | undefined;
    expect(props).toBeDefined();
    const sections = [
      "logLevel",
      "telemetry",
      "limits",
      "loopDetection",
      "spawn",
      "forge",
      "modelRouter",
      "features",
    ];
    for (const section of sections) {
      expect(props?.[section]).toBeDefined();
    }
  });
});
