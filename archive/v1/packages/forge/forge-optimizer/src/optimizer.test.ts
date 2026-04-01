import { describe, expect, mock, test } from "bun:test";
import type {
  BrickArtifact,
  BrickFitnessMetrics,
  BrickId,
  ForgeStore,
  KoiError,
  Result,
} from "@koi/core";
import { brickId } from "@koi/core";
import { createTestToolArtifact, DEFAULT_PROVENANCE } from "@koi/test-utils";
import { computeFitnessScore, createBrickOptimizer } from "./optimizer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFitness(overrides: Partial<BrickFitnessMetrics> = {}): BrickFitnessMetrics {
  return {
    successCount: 10,
    errorCount: 0,
    latency: { samples: [100, 200, 150], count: 3, cap: 200 },
    lastUsedAt: 1000,
    ...overrides,
  };
}

function createCrystallizedBrick(id: string, fitness?: BrickFitnessMetrics): BrickArtifact {
  return createTestToolArtifact({
    id: brickId(id),
    name: `composite-${id}`,
    fitness,
    provenance: {
      ...DEFAULT_PROVENANCE,
      source: { origin: "forged", forgedBy: "auto-forge-middleware" },
      buildDefinition: {
        buildType: "koi.crystallize/composite/v1",
        externalParameters: {
          ngramKey: "fetch|parse|save",
          occurrences: 5,
          score: 10,
        },
      },
    },
  });
}

function createMockStore(bricks: readonly BrickArtifact[]): ForgeStore {
  const brickMap = new Map<string, BrickArtifact>();
  for (const brick of bricks) {
    brickMap.set(brick.id, brick);
  }

  return {
    save: mock(async (): Promise<Result<void, KoiError>> => ({ ok: true, value: undefined })),
    load: mock(async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
      const brick = brickMap.get(id);
      if (brick === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Not found: ${id}`, retryable: false },
        };
      }
      return { ok: true, value: brick };
    }),
    search: mock(async (): Promise<Result<readonly BrickArtifact[], KoiError>> => {
      return { ok: true, value: [...brickMap.values()] };
    }),
    remove: mock(async (): Promise<Result<void, KoiError>> => ({ ok: true, value: undefined })),
    update: mock(async (): Promise<Result<void, KoiError>> => ({ ok: true, value: undefined })),
    exists: mock(async (): Promise<Result<boolean, KoiError>> => ({ ok: true, value: true })),
  };
}

// ---------------------------------------------------------------------------
// computeFitnessScore
// ---------------------------------------------------------------------------

describe("computeFitnessScore", () => {
  const WINDOW = 7 * 24 * 60 * 60 * 1000; // 7 days

  test("returns 0 for zero invocations", () => {
    const fitness = createFitness({ successCount: 0, errorCount: 0 });
    expect(computeFitnessScore(fitness, 1000, WINDOW)).toBe(0);
  });

  test("returns positive score for successful invocations", () => {
    const fitness = createFitness({ successCount: 10, errorCount: 0 });
    const score = computeFitnessScore(fitness, 1000, WINDOW);
    expect(score).toBeGreaterThan(0);
  });

  test("lower success rate reduces score", () => {
    const highSuccess = createFitness({ successCount: 10, errorCount: 0 });
    const lowSuccess = createFitness({ successCount: 5, errorCount: 5 });
    const now = 1000;

    expect(computeFitnessScore(highSuccess, now, WINDOW)).toBeGreaterThan(
      computeFitnessScore(lowSuccess, now, WINDOW),
    );
  });

  test("higher latency reduces score", () => {
    const fast = createFitness({
      latency: { samples: [10, 20, 15], count: 3, cap: 200 },
    });
    const slow = createFitness({
      latency: { samples: [1000, 2000, 1500], count: 3, cap: 200 },
    });
    const now = 1000;

    expect(computeFitnessScore(fast, now, WINDOW)).toBeGreaterThan(
      computeFitnessScore(slow, now, WINDOW),
    );
  });

  test("older bricks get lower scores", () => {
    const fitness = createFitness({ lastUsedAt: 0 });
    const recent = computeFitnessScore(fitness, 1000, WINDOW);
    const old = computeFitnessScore(fitness, WINDOW * 2, WINDOW);

    expect(recent).toBeGreaterThan(old);
  });

  test("empty latency samples uses 1ms default", () => {
    const fitness = createFitness({
      latency: { samples: [], count: 0, cap: 200 },
    });
    const score = computeFitnessScore(fitness, 1000, WINDOW);
    expect(score).toBeGreaterThan(0);
  });

  test("score halves after one window period", () => {
    const fitness = createFitness({ lastUsedAt: 0 });
    const scoreAtZero = computeFitnessScore(fitness, 0, WINDOW);
    const scoreAtWindow = computeFitnessScore(fitness, WINDOW, WINDOW);
    expect(scoreAtWindow).toBeCloseTo(scoreAtZero / 2, 5);
  });
});

// ---------------------------------------------------------------------------
// createBrickOptimizer - evaluate
// ---------------------------------------------------------------------------

describe("createBrickOptimizer - evaluate", () => {
  test("returns insufficient_data when brick not found", async () => {
    const store = createMockStore([]);
    const optimizer = createBrickOptimizer({ store, clock: () => 1000 });

    const result = await optimizer.evaluate(brickId("nonexistent"));
    expect(result.action).toBe("insufficient_data");
    expect(result.reason).toContain("not found");
  });

  test("returns insufficient_data when no fitness metrics", async () => {
    const brick = createCrystallizedBrick("brick-1");
    const store = createMockStore([brick]);
    const optimizer = createBrickOptimizer({ store, clock: () => 1000 });

    const result = await optimizer.evaluate(brick.id);
    expect(result.action).toBe("insufficient_data");
    expect(result.reason).toContain("No fitness metrics");
  });

  test("returns insufficient_data when below minSampleSize", async () => {
    const fitness = createFitness({ successCount: 5, errorCount: 2 }); // 7 total
    const brick = createCrystallizedBrick("brick-1", fitness);
    const store = createMockStore([brick]);
    const optimizer = createBrickOptimizer({
      store,
      minSampleSize: 20,
      clock: () => 1000,
    });

    const result = await optimizer.evaluate(brick.id);
    expect(result.action).toBe("insufficient_data");
    expect(result.reason).toContain("7/20");
  });

  test("returns keep when no component data available", async () => {
    const fitness = createFitness({ successCount: 15, errorCount: 5 });
    const brick = createCrystallizedBrick("brick-1", fitness);
    const store = createMockStore([brick]);
    // search returns empty (no component tools)
    (store.search as ReturnType<typeof mock>).mockImplementation(async () => ({
      ok: true,
      value: [],
    }));

    const optimizer = createBrickOptimizer({
      store,
      minSampleSize: 10,
      clock: () => 1000,
    });

    const result = await optimizer.evaluate(brick.id);
    expect(result.action).toBe("keep");
    expect(result.reason).toContain("No component tool data");
  });

  test("returns promote_to_policy for harness-synth bricks with 100% success", async () => {
    const fitness = createFitness({
      successCount: 60,
      errorCount: 0,
      latency: { samples: [50], count: 1, cap: 200 },
      lastUsedAt: 1000,
    });
    const brick = createTestToolArtifact({
      id: brickId("harness-1"),
      name: "harness-test",
      fitness,
      provenance: {
        ...DEFAULT_PROVENANCE,
        source: { origin: "forged", forgedBy: "harness-synth" },
        buildDefinition: {
          buildType: "koi.harness-synth/middleware/v1",
          externalParameters: {},
        },
      },
    });

    const store = createMockStore([brick]);
    const optimizer = createBrickOptimizer({
      store,
      minSampleSize: 10,
      minPolicySamples: 50,
      clock: () => 1000,
    });

    const result = await optimizer.evaluate(brick.id);
    expect(result.action).toBe("promote_to_policy");
    expect(result.reason).toContain("100% success rate");
    expect(result.reason).toContain("60");
  });

  test("does not promote to policy when below minPolicySamples", async () => {
    const fitness = createFitness({
      successCount: 30,
      errorCount: 0,
      latency: { samples: [50], count: 1, cap: 200 },
      lastUsedAt: 1000,
    });
    const brick = createTestToolArtifact({
      id: brickId("harness-2"),
      name: "harness-test",
      fitness,
      provenance: {
        ...DEFAULT_PROVENANCE,
        source: { origin: "forged", forgedBy: "harness-synth" },
        buildDefinition: {
          buildType: "koi.harness-synth/middleware/v1",
          externalParameters: {},
        },
      },
    });

    const store = createMockStore([brick]);
    const optimizer = createBrickOptimizer({
      store,
      minSampleSize: 10,
      minPolicySamples: 50,
      clock: () => 1000,
    });

    const result = await optimizer.evaluate(brick.id);
    // 30 < 50 minPolicySamples — should keep, not promote
    expect(result.action).not.toBe("promote_to_policy");
  });

  test("does not promote non-harness-synth bricks to policy", async () => {
    const fitness = createFitness({
      successCount: 60,
      errorCount: 0,
      latency: { samples: [50], count: 1, cap: 200 },
      lastUsedAt: 1000,
    });
    const brick = createCrystallizedBrick("auto-forge-1", fitness);

    const store = createMockStore([brick]);
    const optimizer = createBrickOptimizer({
      store,
      minSampleSize: 10,
      minPolicySamples: 50,
      clock: () => 1000,
    });

    const result = await optimizer.evaluate(brick.id);
    // auto-forge-middleware bricks should not be promoted to policy
    expect(result.action).not.toBe("promote_to_policy");
  });

  test("returns keep when composite fitness exceeds threshold", async () => {
    const compositeFitness = createFitness({
      successCount: 30,
      errorCount: 0,
      latency: { samples: [50], count: 1, cap: 200 },
      lastUsedAt: 1000,
    });
    const brick = createCrystallizedBrick("brick-1", compositeFitness);

    const componentBrick = createTestToolArtifact({
      id: brickId("component-fetch"),
      name: "fetch",
      fitness: createFitness({
        successCount: 20,
        errorCount: 10, // much worse success rate
        latency: { samples: [200], count: 1, cap: 200 },
        lastUsedAt: 1000,
      }),
    });

    // First call loads the brick, subsequent calls search for components
    let searchCallCount = 0; // justified: mutable counter for test mock
    const store = createMockStore([brick]);
    (store.search as ReturnType<typeof mock>).mockImplementation(async () => {
      searchCallCount += 1;
      if (searchCallCount === 1) {
        // sweep search: return all bricks
        return { ok: true, value: [brick] };
      }
      // component search
      return { ok: true, value: [componentBrick] };
    });

    const optimizer = createBrickOptimizer({
      store,
      minSampleSize: 10,
      improvementThreshold: 0.1,
      clock: () => 1000,
    });

    const result = await optimizer.evaluate(brick.id);
    expect(result.action).toBe("keep");
    expect(result.fitnessOriginal).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// createBrickOptimizer - sweep
// ---------------------------------------------------------------------------

describe("createBrickOptimizer - sweep", () => {
  test("returns empty when no bricks found", async () => {
    const store = createMockStore([]);
    (store.search as ReturnType<typeof mock>).mockImplementation(async () => ({
      ok: true,
      value: [],
    }));
    const optimizer = createBrickOptimizer({ store, clock: () => 1000 });

    const results = await optimizer.sweep();
    expect(results).toHaveLength(0);
  });

  test("skips non-crystallized bricks", async () => {
    const normalBrick = createTestToolArtifact({
      id: brickId("normal-1"),
      fitness: createFitness({ successCount: 30, errorCount: 0 }),
    });
    const store = createMockStore([normalBrick]);

    const optimizer = createBrickOptimizer({ store, clock: () => 1000 });
    const results = await optimizer.sweep();
    expect(results).toHaveLength(0);
  });

  test("auto-deprecates bricks with action deprecate", async () => {
    const fitness = createFitness({
      successCount: 5,
      errorCount: 15, // very poor success rate
      latency: { samples: [500], count: 1, cap: 200 },
      lastUsedAt: 1000,
    });
    const brick = createCrystallizedBrick("brick-1", fitness);

    const componentBrick = createTestToolArtifact({
      id: brickId("component-fetch"),
      name: "fetch",
      fitness: createFitness({
        successCount: 30,
        errorCount: 0, // much better
        latency: { samples: [50], count: 1, cap: 200 },
        lastUsedAt: 1000,
      }),
    });

    const store = createMockStore([brick]);
    let searchCallCount = 0; // justified: mutable counter for test mock
    (store.search as ReturnType<typeof mock>).mockImplementation(async () => {
      searchCallCount += 1;
      if (searchCallCount === 1) {
        return { ok: true, value: [brick] };
      }
      return { ok: true, value: [componentBrick] };
    });

    const optimizer = createBrickOptimizer({
      store,
      minSampleSize: 10,
      clock: () => 1000,
    });

    const results = await optimizer.sweep();
    const deprecated = results.filter((r) => r.action === "deprecate");
    expect(deprecated.length).toBeGreaterThanOrEqual(1);

    // Should have called update with lifecycle: "deprecated"
    expect(store.update).toHaveBeenCalled();
  });

  test("handles store search error gracefully", async () => {
    const store = createMockStore([]);
    (store.search as ReturnType<typeof mock>).mockImplementation(async () => ({
      ok: false,
      error: { code: "INTERNAL", message: "error", retryable: false },
    }));

    const optimizer = createBrickOptimizer({ store, clock: () => 1000 });
    const results = await optimizer.sweep();
    expect(results).toHaveLength(0);
  });
});
