/**
 * Tier definitions and priority ordering for the overlay store.
 *
 * 4-tier hierarchy (highest to lowest priority):
 * 1. agent      — per-agent forged bricks (read-write, default write target)
 * 2. shared     — shared across agents (read-write)
 * 3. extensions — user-installed extension packs (read-only)
 * 4. bundled    — ships with Koi distribution (read-only)
 */

export type TierName = "agent" | "shared" | "extensions" | "bundled";

export type TierAccess = "read-write" | "read-only";

export interface TierDescriptor {
  readonly name: TierName;
  readonly access: TierAccess;
  readonly baseDir: string;
  /** Enable filesystem watcher for cross-process change detection. Default: false. */
  readonly watch?: boolean;
}

/** Tier search order — highest priority first. */
export const TIER_PRIORITY: readonly TierName[] = [
  "agent",
  "shared",
  "extensions",
  "bundled",
] as const;

/** Returns true if the tier allows write operations. */
export function isTierWritable(tier: TierDescriptor): boolean {
  return tier.access === "read-write";
}
