/**
 * Lineage helpers — parent→child traversal and content-equivalent duplicate
 * detection.
 *
 * Bricks are immutable; "evolution" is modeled as a new brick with
 * `provenance.parentBrickId` pointing at its ancestor.
 */

import type { BrickArtifact, BrickId, ForgeStore } from "@koi/core";

/** Maximum lineage walk depth — prevents infinite loops on malformed chains. */
export const MAX_LINEAGE_DEPTH = 64;

export function getParentBrickId(brick: BrickArtifact): BrickId | undefined {
  return brick.provenance.parentBrickId;
}

/**
 * Walks the `parentBrickId` chain upwards from `child` to determine whether
 * `ancestor` is in its lineage. Bounded by `MAX_LINEAGE_DEPTH`; cycles fail
 * closed by returning `false`.
 */
export async function isDerivedFrom(
  child: BrickArtifact,
  ancestor: BrickId,
  store: ForgeStore,
): Promise<boolean> {
  const seen = new Set<BrickId>([child.id]);
  let parentId = getParentBrickId(child);
  let steps = 0;

  while (parentId !== undefined && steps < MAX_LINEAGE_DEPTH) {
    if (parentId === ancestor) return true;
    if (seen.has(parentId)) return false;
    seen.add(parentId);

    const result = await store.load(parentId);
    if (!result.ok) return false;
    parentId = getParentBrickId(result.value);
    steps += 1;
  }
  return false;
}

/**
 * Returns the first brick in `bricks` whose stored `id` equals `candidateId`.
 * Since `BrickId` is content-addressed, equality of IDs implies equality of
 * canonical content — a hit means the candidate is a duplicate.
 */
export function findDuplicateById(
  bricks: readonly BrickArtifact[],
  candidateId: BrickId,
): BrickArtifact | undefined {
  return bricks.find((b) => b.id === candidateId);
}
