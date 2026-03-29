/**
 * computeLineage — walk the evolution chain from a brick back to its root ancestor.
 *
 * Pure utility function operating on ForgeStore.load() — no store interface changes needed.
 * Returns the ancestor chain in order from root → ... → brick (oldest first).
 */

import type { BrickArtifact, BrickId, ForgeStore, KoiError, Result } from "@koi/core";

/** Default maximum depth for lineage traversal to prevent runaway walks. */
const DEFAULT_MAX_DEPTH = 50;

/**
 * Result of a lineage computation.
 *
 * `chain` is ordered root-first: [root, ..., parent, brick].
 * `partial` is true when the chain was truncated (missing parent or depth limit reached).
 */
export interface LineageResult {
  /** Ancestor chain ordered root-first (oldest → newest). */
  readonly chain: readonly BrickArtifact[];
  /** True if the chain is incomplete (missing parent, store error, or depth limit). */
  readonly partial: boolean;
}

/**
 * Walk the `parentBrickId` chain from a brick back to its root ancestor.
 *
 * - Returns the full chain root-first: [root, ..., parent, brick]
 * - Stops at depth limit (default 50) to prevent infinite traversal
 * - Detects cycles (brick appearing twice in chain) and stops
 * - Returns partial chain with `partial: true` on missing parent or store error
 */
export async function computeLineage(
  store: ForgeStore,
  startId: BrickId,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): Promise<Result<LineageResult, KoiError>> {
  const chain: BrickArtifact[] = [];
  const seen = new Set<string>();
  let currentId: BrickId | undefined = startId;

  while (currentId !== undefined && chain.length < maxDepth) {
    // Cycle detection
    if (seen.has(currentId)) {
      return {
        ok: true,
        value: { chain: chain.reverse(), partial: true },
      };
    }
    seen.add(currentId);

    const loadResult = await store.load(currentId);
    if (!loadResult.ok) {
      // If we haven't loaded anything yet, the starting brick itself is missing
      if (chain.length === 0) {
        return loadResult;
      }
      // Partial chain — parent not found in store
      return {
        ok: true,
        value: { chain: chain.reverse(), partial: true },
      };
    }

    chain.push(loadResult.value);
    currentId = loadResult.value.provenance.evolution?.parentBrickId;
  }

  // If we exited because of depth limit but there's still a parent, it's partial
  const lastBrick = chain[chain.length - 1];
  const hasMoreParents = lastBrick?.provenance.evolution?.parentBrickId !== undefined;
  const hitDepthLimit = chain.length >= maxDepth && hasMoreParents;

  return {
    ok: true,
    value: {
      chain: chain.reverse(),
      partial: hitDepthLimit,
    },
  };
}
