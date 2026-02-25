/**
 * Usage-based auto-promotion — tracks brick usage and promotes trust tier
 * when configurable thresholds are crossed.
 */

import type { BrickArtifact, ForgeStore, KoiError, Result, TrustTier } from "@koi/core";
import { brickId as toBrickId } from "@koi/core";
import type { AutoPromotionConfig, ForgeConfig } from "./config.js";
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

export interface UsagePromotedResult {
  readonly kind: "promoted";
  readonly brickId: string;
  readonly newUsageCount: number;
  readonly previousTier: TrustTier;
  readonly newTier: TrustTier;
}

export type UsageResult = UsageRecordedResult | UsagePromotedResult;

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
 * Records a single usage of a brick. Increments `usageCount` and, when
 * auto-promotion is enabled and a threshold is crossed, promotes the
 * brick's trust tier.
 */
export async function recordBrickUsage(
  store: ForgeStore,
  brickId: string,
  config: ForgeConfig,
): Promise<Result<UsageResult, ForgeError>> {
  const loadResult = await store.load(toBrickId(brickId));
  if (!loadResult.ok) {
    return { ok: false, error: toForgeError(loadResult.error) };
  }

  const brick: BrickArtifact = loadResult.value;
  const newUsageCount = brick.usageCount + 1;
  const promotedTier = computeAutoPromotion(brick.trustTier, newUsageCount, config.autoPromotion);

  const updateResult = await store.update(toBrickId(brickId), {
    usageCount: newUsageCount,
    ...(promotedTier !== undefined ? { trustTier: promotedTier } : {}),
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
