import { describe, expect, test } from "bun:test";
import type { BrickFitnessMetrics } from "@koi/core";
import { DEFAULT_BRICK_FITNESS } from "@koi/core";
import { createLatencySampler, recordLatency } from "@koi/validation";
import { computeMergedFitness, shouldFlush } from "./fitness-flush.js";
import type { ToolFlushState } from "./tool-health.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFlushState(overrides?: Partial<ToolFlushState>): ToolFlushState {
  return {
    totalSuccesses: 0,
    totalFailures: 0,
    latencyBuffer: [],
    latencyTotalCount: 0,
    dirty: false,
    flushing: false,
    invocationsSinceFlush: 0,
    lastFlushedSuccesses: 0,
    lastFlushedFailures: 0,
    lastFlushedErrorRate: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// shouldFlush
// ---------------------------------------------------------------------------

describe("shouldFlush", () => {
  test("returns true after K=10 invocations", () => {
    const state = createFlushState({
      dirty: true,
      invocationsSinceFlush: 10,
      totalSuccesses: 8,
      totalFailures: 2,
    });
    expect(shouldFlush(state, 10, 0.05)).toBe(true);
  });

  test("returns true when error rate delta > 0.05", () => {
    // 5 failures out of 10 = 50% error rate, delta from 0 = 0.5 > 0.05
    const state = createFlushState({
      dirty: true,
      invocationsSinceFlush: 3, // below threshold of 10
      totalSuccesses: 5,
      totalFailures: 5,
      lastFlushedErrorRate: 0,
    });
    expect(shouldFlush(state, 10, 0.05)).toBe(true);
  });

  test("returns false when below both thresholds", () => {
    // 1 out of 5 = 20% error rate, delta from 0.18 = 0.02 < 0.05
    const state = createFlushState({
      dirty: true,
      invocationsSinceFlush: 5, // below 10
      totalSuccesses: 4,
      totalFailures: 1,
      lastFlushedErrorRate: 0.18,
    });
    expect(shouldFlush(state, 10, 0.05)).toBe(false);
  });

  test("returns false when flushing is true", () => {
    const state = createFlushState({
      dirty: true,
      flushing: true,
      invocationsSinceFlush: 20,
    });
    expect(shouldFlush(state, 10, 0.05)).toBe(false);
  });

  test("returns false when not dirty", () => {
    const state = createFlushState({
      dirty: false,
      invocationsSinceFlush: 20,
    });
    expect(shouldFlush(state, 10, 0.05)).toBe(false);
  });

  test("returns false when zero invocations", () => {
    const state = createFlushState({ dirty: true, invocationsSinceFlush: 0 });
    expect(shouldFlush(state, 10, 0.05)).toBe(false);
  });

  test("error rate delta uses absolute value", () => {
    // Error rate went from 0.5 down to 0.1, delta = |0.1 - 0.5| = 0.4 > 0.05
    const state = createFlushState({
      dirty: true,
      invocationsSinceFlush: 3,
      totalSuccesses: 9,
      totalFailures: 1,
      lastFlushedErrorRate: 0.5,
    });
    expect(shouldFlush(state, 10, 0.05)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeMergedFitness
// ---------------------------------------------------------------------------

describe("computeMergedFitness", () => {
  test("correctly adds deltas to existing counts", () => {
    const existing: BrickFitnessMetrics = {
      successCount: 10,
      errorCount: 2,
      latency: createLatencySampler(200),
      lastUsedAt: 1000,
    };
    const merged = computeMergedFitness(
      { successDelta: 5, failureDelta: 1, latencyBuffer: [], lastUsedAt: 2000 },
      existing,
    );
    expect(merged.successCount).toBe(15);
    expect(merged.errorCount).toBe(3);
  });

  test("uses DEFAULT_BRICK_FITNESS when existing is undefined", () => {
    const merged = computeMergedFitness(
      { successDelta: 3, failureDelta: 1, latencyBuffer: [50, 100], lastUsedAt: 5000 },
      undefined,
    );
    expect(merged.successCount).toBe(3);
    expect(merged.errorCount).toBe(1);
    expect(merged.lastUsedAt).toBe(5000);
    expect(merged.latency.count).toBe(2);
  });

  test("merges latency samplers", () => {
    // Existing has some samples
    let existingLatency = createLatencySampler(200);
    existingLatency = recordLatency(existingLatency, 10);
    existingLatency = recordLatency(existingLatency, 20);

    const existing: BrickFitnessMetrics = {
      successCount: 5,
      errorCount: 0,
      latency: existingLatency,
      lastUsedAt: 1000,
    };

    const merged = computeMergedFitness(
      { successDelta: 2, failureDelta: 0, latencyBuffer: [30, 40], lastUsedAt: 2000 },
      existing,
    );

    // merged sampler should have 4 samples total
    expect(merged.latency.samples).toHaveLength(4);
    // Samples should be sorted
    const samples = merged.latency.samples;
    for (let i = 1; i < samples.length; i++) {
      const current = samples[i];
      const previous = samples[i - 1];
      if (current !== undefined && previous !== undefined) {
        expect(current).toBeGreaterThanOrEqual(previous);
      }
    }
  });

  test("uses max(existing.lastUsedAt, new.lastUsedAt)", () => {
    const existing: BrickFitnessMetrics = {
      ...DEFAULT_BRICK_FITNESS,
      lastUsedAt: 5000,
    };
    const merged = computeMergedFitness(
      { successDelta: 1, failureDelta: 0, latencyBuffer: [], lastUsedAt: 3000 },
      existing,
    );
    expect(merged.lastUsedAt).toBe(5000);

    const merged2 = computeMergedFitness(
      { successDelta: 1, failureDelta: 0, latencyBuffer: [], lastUsedAt: 8000 },
      existing,
    );
    expect(merged2.lastUsedAt).toBe(8000);
  });

  test("handles empty latency buffer", () => {
    const merged = computeMergedFitness(
      { successDelta: 1, failureDelta: 0, latencyBuffer: [], lastUsedAt: 1000 },
      DEFAULT_BRICK_FITNESS,
    );
    expect(merged.latency.samples).toHaveLength(0);
    expect(merged.latency.count).toBe(0);
  });
});
