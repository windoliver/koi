/**
 * Lineage helpers — parent→child traversal and content-equivalent duplicate
 * detection.
 *
 * Bricks are immutable; "evolution" is modeled as a new brick with
 * `provenance.parentBrickId` pointing at its ancestor. `isDerivedFrom`
 * returns a typed result so callers can distinguish "definitely not derived"
 * from a transient store outage and decide whether to retry or fail closed.
 */

import type { BrickArtifact, BrickId, ForgeStore, KoiError } from "@koi/core";

/** Maximum lineage walk depth — prevents infinite loops on malformed chains. */
export const MAX_LINEAGE_DEPTH = 64;

export type LineageOutcome =
  | { readonly kind: "derived" }
  | { readonly kind: "not_derived" }
  | { readonly kind: "depth_exceeded"; readonly depth: number }
  | { readonly kind: "cycle_detected"; readonly at: BrickId }
  | { readonly kind: "store_error"; readonly at: BrickId; readonly error: KoiError };

export function getParentBrickId(brick: BrickArtifact): BrickId | undefined {
  return brick.provenance.parentBrickId;
}

/**
 * Walks the `parentBrickId` chain upwards from `child` to determine whether
 * `ancestor` is in its lineage. Surfaces the reason for a non-positive
 * answer so callers can distinguish a true non-lineage relationship from a
 * store outage, a depth overrun, or a malformed cycle.
 */
export async function isDerivedFrom(
  child: BrickArtifact,
  ancestor: BrickId,
  store: ForgeStore,
): Promise<LineageOutcome> {
  const seen = new Set<BrickId>([child.id]);
  let parentId = getParentBrickId(child);
  let steps = 0;

  while (parentId !== undefined) {
    if (parentId === ancestor) return { kind: "derived" };
    if (seen.has(parentId)) return { kind: "cycle_detected", at: parentId };
    if (steps >= MAX_LINEAGE_DEPTH) return { kind: "depth_exceeded", depth: steps };
    seen.add(parentId);

    const result = await store.load(parentId);
    if (!result.ok) return { kind: "store_error", at: parentId, error: result.error };

    parentId = getParentBrickId(result.value);
    steps += 1;
  }
  return { kind: "not_derived" };
}

/**
 * Returns the first brick in `bricks` whose stored `id` equals `candidateId`.
 * Since `BrickId` is content-addressed, equality of IDs implies equality of
 * canonical content under the producer's identity scheme — a hit means the
 * candidate is a duplicate.
 */
export function findDuplicateById(
  bricks: readonly BrickArtifact[],
  candidateId: BrickId,
): BrickArtifact | undefined {
  return bricks.find((b) => b.id === candidateId);
}
