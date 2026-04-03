/**
 * Drift checker — detects source file staleness for forge bricks.
 *
 * Injected into ForgeResolver to lazily compute drift scores on load().
 * Uses @koi/git-utils for changed file detection and @koi/validation
 * for drift score computation. Implements TTL-based caching to avoid
 * redundant git diff calls.
 */

import type { BrickDriftContext } from "@koi/core";
import type { DriftChecker, DriftCheckResult } from "@koi/forge-types";
import type {
  changedFilesSince as ChangedFilesSinceFn,
  getHeadCommit as GetHeadCommitFn,
} from "@koi/git-utils";
import { computeDrift } from "@koi/validation";

// Re-export types from forge-types for backward compatibility
export type { DriftChecker, DriftCheckResult } from "@koi/forge-types";

/** Configuration for the concrete drift checker. */
export interface DriftCheckerConfig {
  /** Working directory for git commands. */
  readonly cwd: string;
  /** TTL in milliseconds for the changed-files cache. Default: 60_000. */
  readonly cacheTtlMs?: number;
  /** Injected git functions (enables testing without real repos). */
  readonly git: {
    readonly changedFilesSince: typeof ChangedFilesSinceFn;
    readonly getHeadCommit: typeof GetHeadCommitFn;
  };
}

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly changedFiles: readonly string[];
  readonly fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_TTL_MS = 60_000;

/** Creates a concrete DriftChecker with TTL-cached git diff results. */
export function createDriftChecker(config: DriftCheckerConfig): DriftChecker {
  const cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  const checkDrift = async (
    driftContext: BrickDriftContext,
  ): Promise<DriftCheckResult | undefined> => {
    if (driftContext.sourceFiles.length === 0) return undefined;

    // Get current HEAD
    const headResult = await config.git.getHeadCommit(config.cwd);
    if (!headResult.ok) return undefined;
    const currentCommit = headResult.value;

    // Skip if same commit as last check
    if (driftContext.lastCheckedCommit === currentCommit) return undefined;

    // Use cached changed files if within TTL
    const baseCommit = driftContext.lastCheckedCommit ?? currentCommit;
    const cached = cache.get(baseCommit);
    const now = Date.now();
    // let: conditionally assigned from cache or fresh git call
    let changedFiles: readonly string[];

    if (cached !== undefined && now - cached.fetchedAt < cacheTtlMs) {
      changedFiles = cached.changedFiles;
    } else {
      const diffResult = await config.git.changedFilesSince(baseCommit, config.cwd);
      if (!diffResult.ok) return undefined;
      changedFiles = diffResult.value;
      cache.set(baseCommit, { changedFiles, fetchedAt: now });
    }

    const driftScore = computeDrift(driftContext.sourceFiles, changedFiles);
    return { driftScore, currentCommit };
  };

  return { checkDrift };
}
