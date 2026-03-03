/**
 * Fitness flush — pure functions for persisting runtime health data to ForgeStore.
 *
 * Threshold-based flush: every K invocations OR error rate delta > threshold.
 * Merges cumulative session deltas with existing BrickFitnessMetrics.
 */

import type { BrickFitnessMetrics } from "@koi/core";
import { DEFAULT_BRICK_FITNESS } from "@koi/core";
import { createLatencySampler, mergeSamplers, recordLatency } from "@koi/validation";
import type { ToolFlushState } from "./tool-health.js";

/** Deltas captured at flush time for merging with persisted fitness. */
export interface FlushDeltas {
  readonly successDelta: number;
  readonly failureDelta: number;
  readonly latencyBuffer: readonly number[];
  readonly lastUsedAt: number;
}

/**
 * Determines whether a tool's fitness data should be flushed.
 *
 * Returns true when:
 * - dirty is true AND flushing is false, AND
 * - invocationsSinceFlush >= flushThreshold, OR
 * - |currentErrorRate - lastFlushedErrorRate| > errorRateDeltaThreshold
 */
export function shouldFlush(
  state: ToolFlushState,
  flushThreshold: number,
  errorRateDeltaThreshold: number,
): boolean {
  if (!state.dirty || state.flushing) return false;

  // Invocation count threshold
  if (state.invocationsSinceFlush >= flushThreshold) return true;

  // Error rate delta threshold
  const totalInvocations = state.totalSuccesses + state.totalFailures;
  if (totalInvocations === 0) return false;

  const currentErrorRate = state.totalFailures / totalInvocations;
  const delta = Math.abs(currentErrorRate - state.lastFlushedErrorRate);
  return delta > errorRateDeltaThreshold;
}

/**
 * Merges session deltas with existing persisted fitness metrics.
 *
 * Constructs a LatencySampler from the raw buffer, then merges with existing.
 * Sets usageCount = successCount + errorCount for consistency.
 */
export function computeMergedFitness(
  deltas: FlushDeltas,
  existing: BrickFitnessMetrics | undefined,
): BrickFitnessMetrics {
  const base = existing ?? DEFAULT_BRICK_FITNESS;

  const successCount = base.successCount + deltas.successDelta;
  const errorCount = base.errorCount + deltas.failureDelta;

  // let: reassigned on each loop iteration (recordLatency returns a new immutable sampler)
  let deltaLatency = createLatencySampler(base.latency.cap);
  for (const sample of deltas.latencyBuffer) {
    deltaLatency = recordLatency(deltaLatency, sample);
  }

  const latency = mergeSamplers(base.latency, deltaLatency);
  const lastUsedAt = Math.max(base.lastUsedAt, deltas.lastUsedAt);

  return { successCount, errorCount, latency, lastUsedAt };
}
