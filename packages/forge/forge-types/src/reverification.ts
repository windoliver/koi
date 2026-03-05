/**
 * TTL-based re-verification — checks whether bricks are stale and
 * need re-verification. Sandboxed bricks are re-verified; unsandboxed are not.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ReverificationConfig {
  /** TTL in millis for sandboxed bricks (default: 24h). */
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
 * Returns TTL for a given sandbox status.
 * Unsandboxed bricks are never re-verified — returns undefined.
 */
export function computeTtl(sandbox: boolean, config: ReverificationConfig): number | undefined {
  if (!sandbox) {
    return undefined;
  }
  return config.ttlMs;
}

// ---------------------------------------------------------------------------
// Staleness check
// ---------------------------------------------------------------------------

/**
 * Returns true if the brick needs re-verification based on its
 * lastVerifiedAt timestamp and the TTL for its sandbox status.
 */
export function isStale(
  artifact: {
    readonly sandbox: boolean;
    readonly lastVerifiedAt?: number;
  },
  config: ReverificationConfig,
): boolean {
  const ttl = computeTtl(artifact.sandbox, config);
  if (ttl === undefined) {
    // unsandboxed — never stale
    return false;
  }
  if (artifact.lastVerifiedAt === undefined) {
    // never verified — always stale
    return true;
  }
  const clock = config.now ?? Date.now;
  return clock() - artifact.lastVerifiedAt > ttl;
}
