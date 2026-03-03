/**
 * TTL-based re-verification — checks whether bricks are stale and
 * need re-verification. Single TTL for all non-sandbox tiers (Issue #703).
 */

import type { TrustTier } from "@koi/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ReverificationConfig {
  /** TTL in millis for all non-sandbox bricks (default: 24h). */
  readonly ttlMs: number;
  /** Maximum concurrent re-verifications. */
  readonly maxConcurrency: number;
  /** Injectable clock for testing. Defaults to Date.now. */
  readonly now?: () => number;
}

export const DEFAULT_REVERIFICATION_CONFIG: ReverificationConfig = {
  ttlMs: 24 * 60 * 60 * 1_000, // 24h
  maxConcurrency: 3,
} as const satisfies ReverificationConfig;

// ---------------------------------------------------------------------------
// TTL computation
// ---------------------------------------------------------------------------

/**
 * Returns TTL for a given trust tier.
 * Sandbox bricks are never re-verified — returns undefined.
 */
export function computeTtl(trustTier: TrustTier, config: ReverificationConfig): number | undefined {
  if (trustTier === "sandbox") {
    return undefined;
  }
  return config.ttlMs;
}

// ---------------------------------------------------------------------------
// Staleness check
// ---------------------------------------------------------------------------

/**
 * Returns true if the brick needs re-verification based on its
 * lastVerifiedAt timestamp and the TTL for its trust tier.
 */
export function isStale(
  artifact: {
    readonly trustTier: TrustTier;
    readonly lastVerifiedAt?: number;
  },
  config: ReverificationConfig,
): boolean {
  const ttl = computeTtl(artifact.trustTier, config);
  if (ttl === undefined) {
    // sandbox — never stale
    return false;
  }
  if (artifact.lastVerifiedAt === undefined) {
    // never verified — always stale
    return true;
  }
  const clock = config.now ?? Date.now;
  return clock() - artifact.lastVerifiedAt > ttl;
}
