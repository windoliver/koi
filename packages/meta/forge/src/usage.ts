/**
 * Usage tracking — records brick usage and updates fitness metrics.
 *
 * Auto-promotion has been removed (Issue #703). Trust tier changes
 * are now manual-only via promote_forge.
 */

import type { BrickArtifact, BrickFitnessMetrics, ForgeStore, KoiError, Result } from "@koi/core";
import { DEFAULT_BRICK_FITNESS, DEFAULT_TRAIL_STRENGTH, brickId as toBrickId } from "@koi/core";
import { computeTrailReinforcement, recordLatency } from "@koi/validation";
import type { ForgeConfig } from "./config.js";
import type { ForgeError } from "./errors.js";
import { storeError } from "./errors.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface UsageRecordedResult {
  readonly kind: "recorded";
  readonly brickId: string;
  readonly newUsageCount: number;
}

export type UsageResult = UsageRecordedResult;

// ---------------------------------------------------------------------------
// Usage signal (fitness-aware usage tracking)
// ---------------------------------------------------------------------------

/** Optional signal providing success/failure and latency for fitness tracking. */
export interface UsageSignal {
  readonly success: boolean;
  readonly latencyMs: number;
  readonly timestamp?: number; // defaults to Date.now()
}

// ---------------------------------------------------------------------------
// Orchestrator — loads brick, increments count, updates fitness, persists
// ---------------------------------------------------------------------------

function toForgeError(err: KoiError): ForgeError {
  return storeError("LOAD_FAILED", err.message);
}

/**
 * Computes updated fitness metrics from an existing brick and a usage signal.
 * Returns a new BrickFitnessMetrics object (never mutates).
 */
function computeUpdatedFitness(
  existing: BrickFitnessMetrics,
  signal: UsageSignal,
): BrickFitnessMetrics {
  const now = signal.timestamp ?? Date.now();
  return {
    successCount: existing.successCount + (signal.success ? 1 : 0),
    errorCount: existing.errorCount + (signal.success ? 0 : 1),
    latency: recordLatency(existing.latency, signal.latencyMs),
    lastUsedAt: now,
  };
}

/**
 * Records a single usage of a brick. Increments `usageCount` and updates
 * fitness metrics when `signal` is provided.
 *
 * Trust tier changes are now manual-only via promote_forge (Issue #703).
 */
export async function recordBrickUsage(
  store: ForgeStore,
  brickId: string,
  config: ForgeConfig,
  signal?: UsageSignal,
): Promise<Result<UsageResult, ForgeError>> {
  const loadResult = await store.load(toBrickId(brickId));
  if (!loadResult.ok) {
    return { ok: false, error: toForgeError(loadResult.error) };
  }

  const brick: BrickArtifact = loadResult.value;

  // When signal is provided, update fitness and derive usageCount from it
  const updatedFitness =
    signal !== undefined
      ? computeUpdatedFitness(brick.fitness ?? DEFAULT_BRICK_FITNESS, signal)
      : undefined;
  const newUsageCount =
    updatedFitness !== undefined
      ? updatedFitness.successCount + updatedFitness.errorCount
      : brick.usageCount + 1;

  // Trail strength reinforcement (stigmergic coordination)
  const trailConfig = config.trail;
  const newTrailStrength =
    trailConfig !== undefined
      ? computeTrailReinforcement(brick.trailStrength ?? DEFAULT_TRAIL_STRENGTH, trailConfig)
      : undefined;

  const updateResult = await store.update(toBrickId(brickId), {
    usageCount: newUsageCount,
    ...(updatedFitness !== undefined ? { fitness: updatedFitness } : {}),
    ...(newTrailStrength !== undefined ? { trailStrength: newTrailStrength } : {}),
  });

  if (!updateResult.ok) {
    return { ok: false, error: storeError("SAVE_FAILED", updateResult.error.message) };
  }

  return {
    ok: true,
    value: {
      kind: "recorded",
      brickId,
      newUsageCount,
    },
  };
}
