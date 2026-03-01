import { describe, expect, test } from "bun:test";
import type { BrickArtifact, BrickFitnessMetrics, ForgeStore, Result } from "@koi/core";
import { brickId } from "@koi/core";
import type { MutationPressureConfig } from "./config.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import { checkMutationPressure } from "./mutation-pressure-check.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

const DEFAULT_MUTATION_CONFIG: MutationPressureConfig = {
  enabled: true,
  frozenThreshold: 0.9,
  stableThreshold: 0.5,
  experimentalThreshold: 0.2,
};

function createFitness(
  successCount: number,
  errorCount: number,
  lastUsedAt: number = NOW - 1000,
): BrickFitnessMetrics {
  return {
    successCount,
    errorCount,
    latency: { samples: [], count: 0, cap: 200 },
    lastUsedAt,
  };
}

function createToolBrick(
  name: string,
  tags: readonly string[],
  fitness?: BrickFitnessMetrics,
): BrickArtifact {
  return {
    id: brickId(`test:${name}`),
    kind: "tool",
    name,
    description: `Test tool ${name}`,
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    version: "0.0.1",
    tags,
    usageCount: fitness ? fitness.successCount + fitness.errorCount : 0,
    implementation: "function(){}",
    inputSchema: {},
    provenance: {
      source: { origin: "forged", forgedBy: "test", sessionId: "s1" },
      buildDefinition: { buildType: "test/v1", externalParameters: {} },
      builder: { id: "test/v1" },
      metadata: {
        invocationId: "inv1",
        startedAt: NOW - 10_000,
        finishedAt: NOW - 9_000,
        sessionId: "s1",
        agentId: "agent-1",
        depth: 0,
      },
      verification: {
        passed: true,
        finalTrustTier: "sandbox",
        totalDurationMs: 100,
        stageResults: [],
      },
      classification: "public",
      contentMarkers: [],
      contentHash: `hash:${name}`,
    },
    ...(fitness !== undefined ? { fitness } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkMutationPressure", () => {
  test("allows when tags are empty", async () => {
    const store = createInMemoryForgeStore();
    const result = await checkMutationPressure([], store, DEFAULT_MUTATION_CONFIG, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pressure).toBe("stable");
      expect(result.value.maxFitness).toBe(0);
    }
  });

  test("allows when no overlapping bricks exist", async () => {
    const store = createInMemoryForgeStore();
    const result = await checkMutationPressure(["math"], store, DEFAULT_MUTATION_CONFIG, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pressure).toBe("stable");
      expect(result.value.maxFitness).toBe(0);
    }
  });

  test("blocks when high-fitness brick overlaps (frozen)", async () => {
    const store = createInMemoryForgeStore();
    // High-success, recent brick → high fitness (close to 1.0)
    const highFitness = createFitness(200, 0, NOW - 100);
    const brick = createToolBrick("math-solver", ["math", "algebra"], highFitness);
    await store.save(brick);

    const result = await checkMutationPressure(["math"], store, DEFAULT_MUTATION_CONFIG, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("governance");
      if (result.error.stage === "governance") {
        expect(result.error.code).toBe("MUTATION_PRESSURE_FROZEN");
      }
    }
  });

  test("allows with medium fitness (stable zone)", async () => {
    const store = createInMemoryForgeStore();
    // Medium success rate → medium fitness
    const medFitness = createFitness(60, 40, NOW - 100);
    const brick = createToolBrick("math-ok", ["math"], medFitness);
    await store.save(brick);

    const result = await checkMutationPressure(["math"], store, DEFAULT_MUTATION_CONFIG, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pressure).not.toBe("frozen");
    }
  });

  test("allows with low fitness (aggressive zone)", async () => {
    const store = createInMemoryForgeStore();
    // Very low success rate → low fitness
    const lowFitness = createFitness(5, 95, NOW - 100);
    const brick = createToolBrick("math-bad", ["math"], lowFitness);
    await store.save(brick);

    const result = await checkMutationPressure(["math"], store, DEFAULT_MUTATION_CONFIG, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pressure).toBe("aggressive");
    }
  });

  test("uses highest fitness among multiple bricks", async () => {
    const store = createInMemoryForgeStore();
    const lowBrick = createToolBrick("math-low", ["math"], createFitness(5, 95, NOW - 100));
    const highBrick = createToolBrick("math-high", ["math"], createFitness(200, 0, NOW - 100));
    await store.save(lowBrick);
    await store.save(highBrick);

    const result = await checkMutationPressure(["math"], store, DEFAULT_MUTATION_CONFIG, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "governance") {
      expect(result.error.code).toBe("MUTATION_PRESSURE_FROZEN");
      expect(result.error.message).toContain("math-high");
    }
  });

  test("skips bricks with no fitness data", async () => {
    const store = createInMemoryForgeStore();
    const noFitnessBrick = createToolBrick("math-new", ["math"]);
    await store.save(noFitnessBrick);

    const result = await checkMutationPressure(["math"], store, DEFAULT_MUTATION_CONFIG, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxFitness).toBe(0);
      expect(result.value.dominantBrickId).toBeUndefined();
    }
  });

  test("skips bricks with zero usage", async () => {
    const store = createInMemoryForgeStore();
    const zeroUsage = createFitness(0, 0, 0);
    const brick = createToolBrick("math-zero", ["math"], zeroUsage);
    await store.save(brick);

    const result = await checkMutationPressure(["math"], store, DEFAULT_MUTATION_CONFIG, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxFitness).toBe(0);
    }
  });

  test("fail-open on store error", async () => {
    const failingStore: ForgeStore = {
      save: async () => ({ ok: true, value: undefined }) as Result<void, never>,
      load: async () =>
        ({ ok: false, error: { code: "NOT_FOUND", message: "nope", retryable: false } }) as never,
      search: async () => {
        throw new Error("store unavailable");
      },
      remove: async () => ({ ok: true, value: undefined }) as Result<void, never>,
      update: async () => ({ ok: true, value: undefined }) as Result<void, never>,
      exists: async () => ({ ok: true, value: false }) as Result<boolean, never>,
    };

    const result = await checkMutationPressure(
      ["math"],
      failingStore,
      DEFAULT_MUTATION_CONFIG,
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pressure).toBe("stable");
    }
  });

  test("fail-open on store returning error result", async () => {
    const errorStore: ForgeStore = {
      save: async () => ({ ok: true, value: undefined }) as Result<void, never>,
      load: async () =>
        ({ ok: false, error: { code: "NOT_FOUND", message: "nope", retryable: false } }) as never,
      search: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "db down", retryable: true },
      }),
      remove: async () => ({ ok: true, value: undefined }) as Result<void, never>,
      update: async () => ({ ok: true, value: undefined }) as Result<void, never>,
      exists: async () => ({ ok: true, value: false }) as Result<boolean, never>,
    };

    const result = await checkMutationPressure(["math"], errorStore, DEFAULT_MUTATION_CONFIG, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pressure).toBe("stable");
    }
  });

  test("uses custom thresholds", async () => {
    const store = createInMemoryForgeStore();
    // Fitness ~0.85 with default config would be stable, but custom frozenThreshold=0.8 → frozen
    const fitness = createFitness(150, 5, NOW - 100);
    const brick = createToolBrick("math-good", ["math"], fitness);
    await store.save(brick);

    const customConfig: MutationPressureConfig = {
      enabled: true,
      frozenThreshold: 0.8,
      stableThreshold: 0.5,
      experimentalThreshold: 0.2,
    };

    const result = await checkMutationPressure(["math"], store, customConfig, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "governance") {
      expect(result.error.code).toBe("MUTATION_PRESSURE_FROZEN");
    }
  });
});
