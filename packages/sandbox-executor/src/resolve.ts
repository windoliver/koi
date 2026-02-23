/**
 * Tier resolution logic — resolves each trust tier to a concrete executor.
 *
 * Fallback is downward-only: sandbox can fall back to verified, but
 * never upward (verified → promoted is privilege escalation).
 * Promoted always resolves (built-in executor is the default).
 */

import type { SandboxExecutor, TierResolution, TrustTier } from "@koi/core";

// ---------------------------------------------------------------------------
// Config type (owned by this package, not L0)
// ---------------------------------------------------------------------------

export interface TieredExecutorConfig {
  readonly sandbox?: SandboxExecutor;
  readonly verified?: SandboxExecutor;
  readonly promoted?: SandboxExecutor;
}

// ---------------------------------------------------------------------------
// Tier ordering for downward fallback
// ---------------------------------------------------------------------------

const TIER_ORDER: readonly TrustTier[] = ["sandbox", "verified", "promoted"] as const;

function tierIndex(tier: TrustTier): number {
  return TIER_ORDER.indexOf(tier);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function getExecutor(tier: TrustTier, config: TieredExecutorConfig): SandboxExecutor | undefined {
  if (tier === "sandbox") return config.sandbox;
  if (tier === "verified") return config.verified;
  return config.promoted;
}

/**
 * Resolve a single tier: find the configured executor or fall back downward.
 * Returns undefined if no executor can serve this tier.
 */
function resolveOneTier(
  requestedTier: TrustTier,
  config: TieredExecutorConfig,
): TierResolution | undefined {
  // Try exact match first
  const exact = getExecutor(requestedTier, config);
  if (exact !== undefined) {
    return {
      executor: exact,
      requestedTier,
      resolvedTier: requestedTier,
      fallback: false,
    };
  }

  // Downward fallback: try higher-trust tiers (higher index = more trusted)
  const startIdx = tierIndex(requestedTier) + 1;
  for (let i = startIdx; i < TIER_ORDER.length; i++) {
    const candidateTier = TIER_ORDER[i];
    if (candidateTier === undefined) continue;
    const candidate = getExecutor(candidateTier, config);
    if (candidate !== undefined) {
      return {
        executor: candidate,
        requestedTier,
        resolvedTier: candidateTier,
        fallback: true,
      };
    }
  }

  return undefined;
}

/**
 * Pre-compute resolution for all 3 tiers into an immutable map.
 * Returns undefined for tiers that cannot be resolved.
 */
export function resolveTiers(config: TieredExecutorConfig): ReadonlyMap<TrustTier, TierResolution> {
  const result = new Map<TrustTier, TierResolution>();

  for (const tier of TIER_ORDER) {
    const resolution = resolveOneTier(tier, config);
    if (resolution !== undefined) {
      result.set(tier, resolution);
    }
  }

  return result;
}
