/**
 * Lineage helpers — parent→child traversal and content-equivalent duplicate
 * detection.
 *
 * Bricks are immutable; "evolution" is modeled as a new brick with
 * `provenance.parentBrickId` pointing at its ancestor. `isDerivedFrom`
 * returns a typed result so callers can distinguish "definitely not derived"
 * from a transient store outage and decide whether to retry or fail closed.
 *
 * Both helpers shape-check artifacts before dereferencing nested fields —
 * a corrupt or partially migrated record returned by the store surfaces as
 * a `malformed` outcome rather than throwing into the caller's promise.
 */

import type { BrickArtifact, BrickId, ForgeStore, KoiError } from "@koi/core";

/** Maximum lineage walk depth — prevents infinite loops on malformed chains. */
export const MAX_LINEAGE_DEPTH = 64;

export type LineageOutcome =
  | { readonly kind: "derived" }
  | { readonly kind: "not_derived" }
  | { readonly kind: "depth_exceeded"; readonly depth: number }
  | { readonly kind: "cycle_detected"; readonly at: BrickId }
  | { readonly kind: "store_error"; readonly at: BrickId; readonly error: KoiError }
  | { readonly kind: "malformed"; readonly at?: BrickId; readonly reason: string };

/**
 * Read `provenance.parentBrickId` defensively. Returns `undefined` when the
 * brick is well-formed but has no parent, OR when the artifact's shape is
 * corrupt — callers that need to distinguish those cases should use
 * `inspectLineageShape`.
 */
export function getParentBrickId(brick: BrickArtifact): BrickId | undefined {
  const shape = inspectLineageShape(brick);
  return shape.kind === "ok" ? shape.parentBrickId : undefined;
}

type LineageShape =
  | { readonly kind: "ok"; readonly id: BrickId; readonly parentBrickId: BrickId | undefined }
  | { readonly kind: "malformed"; readonly reason: string };

function inspectLineageShape(brick: BrickArtifact): LineageShape {
  if (brick === null || typeof brick !== "object") {
    return { kind: "malformed", reason: "brick is not an object" };
  }
  if (typeof brick.id !== "string" || brick.id.length === 0) {
    return { kind: "malformed", reason: "brick.id missing or empty" };
  }
  const provenance = brick.provenance;
  if (provenance === null || typeof provenance !== "object") {
    return { kind: "malformed", reason: "brick.provenance missing or not an object" };
  }
  const parent = provenance.parentBrickId;
  if (parent !== undefined && (typeof parent !== "string" || parent.length === 0)) {
    return { kind: "malformed", reason: "brick.provenance.parentBrickId malformed" };
  }
  return { kind: "ok", id: brick.id, parentBrickId: parent };
}

/**
 * Walks the `parentBrickId` chain upwards from `child` to determine whether
 * `ancestor` is in its lineage. Surfaces the reason for a non-positive
 * answer so callers can distinguish a true non-lineage relationship from a
 * store outage, a depth overrun, a malformed record, or a cycle.
 */
export async function isDerivedFrom(
  child: BrickArtifact,
  ancestor: BrickId,
  store: ForgeStore,
): Promise<LineageOutcome> {
  const childShape = inspectLineageShape(child);
  if (childShape.kind === "malformed") {
    return { kind: "malformed", reason: childShape.reason };
  }

  const seen = new Set<BrickId>([childShape.id]);
  let parentId = childShape.parentBrickId;
  let steps = 0;

  while (parentId !== undefined) {
    if (parentId === ancestor) return { kind: "derived" };
    if (seen.has(parentId)) return { kind: "cycle_detected", at: parentId };
    if (steps >= MAX_LINEAGE_DEPTH) return { kind: "depth_exceeded", depth: steps };
    seen.add(parentId);

    let result: Awaited<ReturnType<ForgeStore["load"]>>;
    try {
      result = await store.load(parentId);
    } catch (err: unknown) {
      // Backends may throw/reject on I/O failure, timeout, disposal, or
      // version skew. Normalize all such cases into a typed store_error so
      // callers never see an uncaught rejection from this helper.
      const error: KoiError = {
        code: "INTERNAL",
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
      return { kind: "store_error", at: parentId, error };
    }
    if (!result.ok) return { kind: "store_error", at: parentId, error: result.error };

    const loadedShape = inspectLineageShape(result.value);
    if (loadedShape.kind === "malformed") {
      return { kind: "malformed", at: parentId, reason: loadedShape.reason };
    }
    parentId = loadedShape.parentBrickId;
    steps += 1;
  }
  return { kind: "not_derived" };
}

/**
 * Returns the first brick in `bricks` whose stored `id` equals `candidateId`
 * AND whose `provenance.builder.id` equals `producerBuilderId`.
 *
 * `BrickId` is only globally unique within a single producer's identity
 * scheme: two producers can theoretically mint the same id from different
 * canonical inputs, so equality of `BrickId` alone is not safe as a
 * cross-producer dedup key. This helper requires the caller to scope the
 * lookup to a single producer to prevent false-positive aliasing.
 */
export function findDuplicateById(
  bricks: readonly BrickArtifact[],
  candidateId: BrickId,
  producerBuilderId: string,
): BrickArtifact | undefined {
  return bricks.find(
    (b) => b.id === candidateId && b.provenance?.builder?.id === producerBuilderId,
  );
}
