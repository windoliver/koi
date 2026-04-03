import { describe, expect, test } from "bun:test";
import { validateKoiConfig } from "./schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validConfig(): Record<string, unknown> {
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
      defaultPolicy: "sandbox",
    },
    modelRouter: {
      strategy: "fallback",
      targets: [{ provider: "openai", model: "gpt-4" }],
    },
    features: {},
  };
}

/** Replace a single top-level field in the valid config. */
function withField(key: string, value: unknown): Record<string, unknown> {
  const cfg = validConfig();
  cfg[key] = value;
  return cfg;
}

/** Remove a single top-level field from the valid config. */
function withoutField(key: string): Record<string, unknown> {
  const cfg = validConfig();
  delete cfg[key];
  return cfg;
}

// ---------------------------------------------------------------------------
// Full config validation
// ---------------------------------------------------------------------------

describe("validateKoiConfig (full config)", () => {
  test("accepts a complete valid config", () => {
    const result = validateKoiConfig(validConfig());
    expect(result.ok).toBe(true);
  });

  test("rejects null input", () => {
    expect(validateKoiConfig(null).ok).toBe(false);
  });

  test("rejects string input", () => {
    expect(validateKoiConfig("bad").ok).toBe(false);
  });

  test("rejects empty object (missing required fields)", () => {
    const result = validateKoiConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("KoiConfig validation failed");
    }
  });

  test("rejects when logLevel missing", () => {
    expect(validateKoiConfig(withoutField("logLevel")).ok).toBe(false);
  });

  test("rejects when limits missing", () => {
    expect(validateKoiConfig(withoutField("limits")).ok).toBe(false);
  });

  test("rejects when telemetry missing", () => {
    expect(validateKoiConfig(withoutField("telemetry")).ok).toBe(false);
  });

  test("rejects when spawn missing", () => {
    expect(validateKoiConfig(withoutField("spawn")).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// logLevel section
// ---------------------------------------------------------------------------

describe("validateKoiConfig (logLevel)", () => {
  test.each(["debug", "info", "warn", "error", "silent"] as const)('accepts "%s"', (level) => {
    expect(validateKoiConfig(withField("logLevel", level)).ok).toBe(true);
  });

  test("rejects invalid level", () => {
    expect(validateKoiConfig(withField("logLevel", "verbose")).ok).toBe(false);
  });

  test("rejects number", () => {
    expect(validateKoiConfig(withField("logLevel", 0)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// telemetry section
// ---------------------------------------------------------------------------

describe("validateKoiConfig (telemetry)", () => {
  test("accepts minimal telemetry", () => {
    expect(validateKoiConfig(withField("telemetry", { enabled: false })).ok).toBe(true);
  });

  test("accepts full telemetry", () => {
    const result = validateKoiConfig(
      withField("telemetry", {
        enabled: true,
        endpoint: "https://example.com/telemetry",
        sampleRate: 0.5,
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("rejects sampleRate > 1", () => {
    expect(validateKoiConfig(withField("telemetry", { enabled: true, sampleRate: 1.5 })).ok).toBe(
      false,
    );
  });

  test("rejects sampleRate < 0", () => {
    expect(validateKoiConfig(withField("telemetry", { enabled: true, sampleRate: -0.1 })).ok).toBe(
      false,
    );
  });

  test("rejects invalid endpoint URL", () => {
    expect(
      validateKoiConfig(withField("telemetry", { enabled: true, endpoint: "not-a-url" })).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// limits section
// ---------------------------------------------------------------------------

describe("validateKoiConfig (limits)", () => {
  test("accepts valid limits", () => {
    expect(
      validateKoiConfig(
        withField("limits", { maxTurns: 10, maxDurationMs: 60_000, maxTokens: 50_000 }),
      ).ok,
    ).toBe(true);
  });

  test("rejects zero maxTurns", () => {
    expect(
      validateKoiConfig(
        withField("limits", { maxTurns: 0, maxDurationMs: 60_000, maxTokens: 50_000 }),
      ).ok,
    ).toBe(false);
  });

  test("rejects negative maxDurationMs", () => {
    expect(
      validateKoiConfig(withField("limits", { maxTurns: 10, maxDurationMs: -1, maxTokens: 50_000 }))
        .ok,
    ).toBe(false);
  });

  test("rejects float maxTokens", () => {
    expect(
      validateKoiConfig(
        withField("limits", { maxTurns: 10, maxDurationMs: 60_000, maxTokens: 50.5 }),
      ).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loopDetection section
// ---------------------------------------------------------------------------

describe("validateKoiConfig (loopDetection)", () => {
  test("accepts valid config", () => {
    expect(
      validateKoiConfig(withField("loopDetection", { enabled: true, windowSize: 8, threshold: 3 }))
        .ok,
    ).toBe(true);
  });

  test("accepts with warningThreshold", () => {
    expect(
      validateKoiConfig(
        withField("loopDetection", {
          enabled: true,
          windowSize: 8,
          threshold: 3,
          warningThreshold: 2,
        }),
      ).ok,
    ).toBe(true);
  });

  test("rejects threshold < 2", () => {
    expect(
      validateKoiConfig(withField("loopDetection", { enabled: true, windowSize: 8, threshold: 1 }))
        .ok,
    ).toBe(false);
  });

  test("rejects zero windowSize", () => {
    expect(
      validateKoiConfig(withField("loopDetection", { enabled: true, windowSize: 0, threshold: 3 }))
        .ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// spawn section
// ---------------------------------------------------------------------------

describe("validateKoiConfig (spawn)", () => {
  test("accepts valid spawn config", () => {
    expect(
      validateKoiConfig(withField("spawn", { maxDepth: 3, maxFanOut: 5, maxTotalProcesses: 20 }))
        .ok,
    ).toBe(true);
  });

  test("accepts maxDepth of 0", () => {
    expect(
      validateKoiConfig(withField("spawn", { maxDepth: 0, maxFanOut: 5, maxTotalProcesses: 20 }))
        .ok,
    ).toBe(true);
  });

  test("rejects negative maxDepth", () => {
    expect(
      validateKoiConfig(withField("spawn", { maxDepth: -1, maxFanOut: 5, maxTotalProcesses: 20 }))
        .ok,
    ).toBe(false);
  });

  test("rejects zero maxFanOut", () => {
    expect(
      validateKoiConfig(withField("spawn", { maxDepth: 3, maxFanOut: 0, maxTotalProcesses: 20 }))
        .ok,
    ).toBe(false);
  });

  test("accepts spawnToolIds", () => {
    expect(
      validateKoiConfig(
        withField("spawn", {
          maxDepth: 3,
          maxFanOut: 5,
          maxTotalProcesses: 20,
          spawnToolIds: ["forge_agent"],
        }),
      ).ok,
    ).toBe(true);
  });

  test("rejects empty string in spawnToolIds", () => {
    expect(
      validateKoiConfig(
        withField("spawn", {
          maxDepth: 3,
          maxFanOut: 5,
          maxTotalProcesses: 20,
          spawnToolIds: [""],
        }),
      ).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// forge section
// ---------------------------------------------------------------------------

describe("validateKoiConfig (forge)", () => {
  test("accepts valid forge config", () => {
    expect(
      validateKoiConfig(
        withField("forge", {
          enabled: true,
          maxForgeDepth: 1,
          maxForgesPerSession: 5,
          defaultScope: "agent",
          defaultPolicy: "sandbox",
        }),
      ).ok,
    ).toBe(true);
  });

  test("rejects invalid defaultScope", () => {
    expect(
      validateKoiConfig(
        withField("forge", {
          enabled: true,
          maxForgeDepth: 1,
          maxForgesPerSession: 5,
          defaultScope: "invalid",
          defaultPolicy: "sandbox",
        }),
      ).ok,
    ).toBe(false);
  });

  test("rejects invalid defaultPolicy", () => {
    expect(
      validateKoiConfig(
        withField("forge", {
          enabled: true,
          maxForgeDepth: 1,
          maxForgesPerSession: 5,
          defaultScope: "agent",
          defaultPolicy: "unknown",
        }),
      ).ok,
    ).toBe(false);
  });

  test("rejects negative maxForgeDepth", () => {
    expect(
      validateKoiConfig(
        withField("forge", {
          enabled: true,
          maxForgeDepth: -1,
          maxForgesPerSession: 5,
          defaultScope: "agent",
          defaultPolicy: "sandbox",
        }),
      ).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// modelRouter section
// ---------------------------------------------------------------------------

describe("validateKoiConfig (modelRouter)", () => {
  test("accepts valid router config", () => {
    expect(
      validateKoiConfig(
        withField("modelRouter", {
          strategy: "fallback",
          targets: [{ provider: "openai", model: "gpt-4" }],
        }),
      ).ok,
    ).toBe(true);
  });

  test("rejects empty targets array", () => {
    expect(
      validateKoiConfig(withField("modelRouter", { strategy: "fallback", targets: [] })).ok,
    ).toBe(false);
  });

  test("rejects invalid strategy", () => {
    expect(
      validateKoiConfig(
        withField("modelRouter", {
          strategy: "random",
          targets: [{ provider: "openai", model: "gpt-4" }],
        }),
      ).ok,
    ).toBe(false);
  });

  test("rejects target with empty provider", () => {
    expect(
      validateKoiConfig(
        withField("modelRouter", {
          strategy: "fallback",
          targets: [{ provider: "", model: "gpt-4" }],
        }),
      ).ok,
    ).toBe(false);
  });

  test("accepts target with weight and enabled", () => {
    expect(
      validateKoiConfig(
        withField("modelRouter", {
          strategy: "weighted",
          targets: [{ provider: "openai", model: "gpt-4", weight: 0.5, enabled: true }],
        }),
      ).ok,
    ).toBe(true);
  });
});
