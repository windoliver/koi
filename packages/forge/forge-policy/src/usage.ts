/**
 * Usage-based auto-promotion — tracks brick usage and promotes trust tier
 * when configurable thresholds are crossed.
 */

import type {
  BrickArtifact,
  BrickFitnessMetrics,
  ForgeStore,
  KoiError,
  Result,
  TrustTier,
} from "@koi/core";
import { DEFAULT_BRICK_FITNESS, DEFAULT_TRAIL_STRENGTH, brickId as toBrickId } from "@koi/core";
import type { AutoPromotionConfig, ForgeConfig, ForgeError } from "@koi/forge-types";
import { storeError } from "@koi/forge-types";
import { computeTrailReinforcement, recordLatency } from "@koi/validation";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface UsageRecordedResult {
  readonly kind: "recorded";
  readonly brickId: string;
  readonly newUsageCount: number;
}

export interface UsagePromotedResult {
  readonly kind: "promoted";
  readonly brickId: string;
  readonly newUsageCount: number;
  readonly previousTier: TrustTier;
  readonly newTier: TrustTier;
}

export type UsageResult = UsageRecordedResult | UsagePromotedResult;

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
// Trust tier ordering (for threshold comparisons)
// ---------------------------------------------------------------------------

const TIER_ORDER: Readonly<Record<TrustTier, number>> = {
  sandbox: 0,
  verified: 1,
  promoted: 2,
} as const;

// ---------------------------------------------------------------------------
// Pure — determines if usage count crosses a promotion threshold
// ---------------------------------------------------------------------------

/**
 * Given a brick's current trust tier and its new usage count, returns the
 * tier it should be promoted to — or `undefined` if no promotion applies.
 */
export function computeAutoPromotion(
  currentTier: TrustTier,
  newUsageCount: number,
  config: AutoPromotionConfig,
): TrustTier | undefined {
  if (!config.enabled) {
    return undefined;
  }

  if (currentTier === "sandbox" && newUsageCount >= config.sandboxToVerifiedThreshold) {
    return "verified";
  }

  if (currentTier === "verified" && newUsageCount >= config.verifiedToPromotedThreshold) {
    return "promoted";
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Orchestrator — loads brick, increments count, optionally promotes, persists
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
 * Records a single usage of a brick. Increments `usageCount` and, when
 * auto-promotion is enabled and a threshold is crossed, promotes the
 * brick's trust tier.
 *
 * When `signal` is provided, also updates fitness metrics (success/error
 * counts, latency, recency). The `usageCount` is derived from total
 * fitness calls to stay DRY.
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

  const promotedTier = computeAutoPromotion(brick.trustTier, newUsageCount, config.autoPromotion);

  // Trail strength reinforcement (stigmergic coordination)
  const trailConfig = config.trail;
  const newTrailStrength =
    trailConfig !== undefined
      ? computeTrailReinforcement(brick.trailStrength ?? DEFAULT_TRAIL_STRENGTH, trailConfig)
      : undefined;

  const updateResult = await store.update(toBrickId(brickId), {
    usageCount: newUsageCount,
    ...(promotedTier !== undefined ? { trustTier: promotedTier } : {}),
    ...(updatedFitness !== undefined ? { fitness: updatedFitness } : {}),
    ...(newTrailStrength !== undefined ? { trailStrength: newTrailStrength } : {}),
  });

  if (!updateResult.ok) {
    return { ok: false, error: storeError("SAVE_FAILED", updateResult.error.message) };
  }

  if (promotedTier !== undefined && TIER_ORDER[promotedTier] > TIER_ORDER[brick.trustTier]) {
    return {
      ok: true,
      value: {
        kind: "promoted",
        brickId,
        newUsageCount,
        previousTier: brick.trustTier,
        newTier: promotedTier,
      },
    };
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
