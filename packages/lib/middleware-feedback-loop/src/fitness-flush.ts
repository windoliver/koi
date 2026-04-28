import type { BrickFitnessMetrics } from "@koi/core/brick-store";
import { createLatencySampler, mergeSamplers } from "@koi/validation";
import type { FlushDeltas, ToolFlushState } from "./types.js";

/**
 * Returns true when accumulated state warrants a fitness flush to the store.
 *
 * Two independent triggers:
 * 1. Invocation count has reached the batch threshold.
 * 2. Error rate has shifted enough to warrant an immediate update.
 *
 * Returns false when not dirty or a flush is already in progress.
 */
export function shouldFlush(
  state: ToolFlushState,
  flushThreshold: number,
  errorRateDeltaThreshold: number,
): boolean {
  if (!state.dirty || state.flushing) return false;
  if (state.invocationsSinceFlush >= flushThreshold) return true;
  const delta = Math.abs(state.errorRateSinceFlush - state.lastFlushedErrorRate);
  return delta > errorRateDeltaThreshold;
}

/**
 * Merges cumulative session deltas with existing BrickFitnessMetrics.
 *
 * When existing is undefined (first flush), the deltas become the baseline.
 * Counts are summed; lastUsedAt takes the maximum of both values.
 */
export function computeMergedFitness(
  deltas: FlushDeltas,
  existing: BrickFitnessMetrics | undefined,
): BrickFitnessMetrics {
  const base: BrickFitnessMetrics = existing ?? {
    successCount: 0,
    errorCount: 0,
    latency: createLatencySampler(),
    lastUsedAt: 0,
  };
  return {
    successCount: base.successCount + deltas.successCount,
    errorCount: base.errorCount + deltas.errorCount,
    latency: mergeSamplers(base.latency, deltas.latencySampler),
    lastUsedAt: Math.max(base.lastUsedAt, deltas.lastUsedAt),
  };
}
