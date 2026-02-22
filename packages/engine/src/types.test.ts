import { describe, expect, test } from "bun:test";
import type {
  CreateKoiOptions,
  IterationLimits,
  KoiRuntime,
  LoopDetectionConfig,
  SpawnPolicy,
} from "./types.js";
import { DEFAULT_ITERATION_LIMITS, DEFAULT_LOOP_DETECTION, DEFAULT_SPAWN_POLICY } from "./types.js";

// ---------------------------------------------------------------------------
// IterationLimits
// ---------------------------------------------------------------------------

describe("IterationLimits", () => {
  test("accepts valid config", () => {
    const config: IterationLimits = {
      maxTurns: 10,
      maxDurationMs: 60_000,
      maxTokens: 50_000,
    };
    expect(config.maxTurns).toBe(10);
    expect(config.maxDurationMs).toBe(60_000);
    expect(config.maxTokens).toBe(50_000);
  });

  test("properties are readonly", () => {
    const config: IterationLimits = { maxTurns: 5, maxDurationMs: 1000, maxTokens: 100 };
    // @ts-expect-error — cannot assign to readonly property
    config.maxTurns = 10;
  });
});

// ---------------------------------------------------------------------------
// LoopDetectionConfig
// ---------------------------------------------------------------------------

describe("LoopDetectionConfig", () => {
  test("accepts valid config", () => {
    const config: LoopDetectionConfig = { windowSize: 8, threshold: 3 };
    expect(config.windowSize).toBe(8);
    expect(config.threshold).toBe(3);
  });

  test("properties are readonly", () => {
    const config: LoopDetectionConfig = { windowSize: 4, threshold: 2 };
    // @ts-expect-error — cannot assign to readonly property
    config.windowSize = 10;
  });
});

// ---------------------------------------------------------------------------
// SpawnPolicy
// ---------------------------------------------------------------------------

describe("SpawnPolicy", () => {
  test("accepts valid config", () => {
    const config: SpawnPolicy = { maxDepth: 3, maxFanOut: 5, maxTotalProcesses: 20 };
    expect(config.maxDepth).toBe(3);
    expect(config.maxFanOut).toBe(5);
    expect(config.maxTotalProcesses).toBe(20);
  });

  test("properties are readonly", () => {
    const config: SpawnPolicy = { maxDepth: 2, maxFanOut: 3, maxTotalProcesses: 10 };
    // @ts-expect-error — cannot assign to readonly property
    config.maxDepth = 5;
  });
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("DEFAULT_ITERATION_LIMITS", () => {
  test("has expected default values", () => {
    expect(DEFAULT_ITERATION_LIMITS.maxTurns).toBe(25);
    expect(DEFAULT_ITERATION_LIMITS.maxDurationMs).toBe(300_000);
    expect(DEFAULT_ITERATION_LIMITS.maxTokens).toBe(100_000);
  });

  test("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_ITERATION_LIMITS)).toBe(true);
  });
});

describe("DEFAULT_LOOP_DETECTION", () => {
  test("has expected default values", () => {
    expect(DEFAULT_LOOP_DETECTION.windowSize).toBe(8);
    expect(DEFAULT_LOOP_DETECTION.threshold).toBe(3);
  });

  test("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_LOOP_DETECTION)).toBe(true);
  });
});

describe("DEFAULT_SPAWN_POLICY", () => {
  test("has expected default values", () => {
    expect(DEFAULT_SPAWN_POLICY.maxDepth).toBe(3);
    expect(DEFAULT_SPAWN_POLICY.maxFanOut).toBe(5);
    expect(DEFAULT_SPAWN_POLICY.maxTotalProcesses).toBe(20);
  });

  test("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_SPAWN_POLICY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CreateKoiOptions type tests
// ---------------------------------------------------------------------------

describe("CreateKoiOptions", () => {
  test("manifest and adapter are required", () => {
    // @ts-expect-error — manifest is required
    const _missing1: CreateKoiOptions = {
      adapter: {} as CreateKoiOptions["adapter"],
    };
    void _missing1;

    // @ts-expect-error — adapter is required
    const _missing2: CreateKoiOptions = {
      manifest: {} as CreateKoiOptions["manifest"],
    };
    void _missing2;
  });
});

// ---------------------------------------------------------------------------
// KoiRuntime type tests
// ---------------------------------------------------------------------------

describe("KoiRuntime", () => {
  test("has agent, run, and dispose", () => {
    // Type-level check that KoiRuntime has the expected shape
    type _AssertAgent = KoiRuntime["agent"];
    type _AssertRun = KoiRuntime["run"];
    type _AssertDispose = KoiRuntime["dispose"];
    expect(true).toBe(true);
  });
});
