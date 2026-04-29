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
import { isBrickId } from "@koi/hash";
import type { BrickVerifier } from "./integrity.js";

/** Maximum lineage walk depth — prevents infinite loops on malformed chains. */
export const MAX_LINEAGE_DEPTH = 64;

export type LineageOutcome =
  | { readonly kind: "derived" }
  | { readonly kind: "not_derived" }
  | { readonly kind: "depth_exceeded"; readonly depth: number }
  | { readonly kind: "cycle_detected"; readonly at: BrickId }
  | { readonly kind: "store_error"; readonly at: BrickId; readonly error: KoiError }
  | { readonly kind: "malformed"; readonly at?: BrickId; readonly reason: string }
  | {
      readonly kind: "integrity_failed";
      readonly at: BrickId;
      readonly producerBuilderId: string;
      readonly reason: string;
    };

export interface IsDerivedFromOptions {
  /**
   * Required when the caller intends to trust the result for policy or
   * dedup. Each loaded ancestor is verified under the named producer's
   * scheme before its `parentBrickId` is followed; an ancestor that fails
   * integrity short-circuits with `integrity_failed` instead of letting a
   * corrupt/adversarial record dictate the lineage walk.
   */
  readonly verify: BrickVerifier;
  readonly producerBuilderId: string;
}

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
  if (typeof brick.id !== "string" || !isBrickId(brick.id)) {
    return { kind: "malformed", reason: "brick.id is not a canonical BrickId" };
  }
  const provenance = brick.provenance;
  if (provenance === null || typeof provenance !== "object") {
    return { kind: "malformed", reason: "brick.provenance missing or not an object" };
  }
  const parent = provenance.parentBrickId;
  if (parent !== undefined && (typeof parent !== "string" || !isBrickId(parent))) {
    return {
      kind: "malformed",
      reason: "brick.provenance.parentBrickId is not a canonical BrickId",
    };
  }
  return { kind: "ok", id: brick.id, parentBrickId: parent };
}

/**
 * Walks the `parentBrickId` chain upwards from `child` to determine whether
 * `ancestor` is in its lineage. Surfaces the reason for a non-positive
 * answer so callers can distinguish a true non-lineage relationship from a
 * store outage, a depth overrun, a malformed record, a cycle, or a failed
 * integrity check on a loaded ancestor.
 *
 * Pass `options.verify` + `options.producerBuilderId` to integrity-verify
 * each loaded ancestor before its `parentBrickId` is trusted. Without
 * verification, a stale/corrupt/adversarial record stored under a real
 * brick id could rewrite its parent pointer and silently mislead the walk.
 */
export async function isDerivedFrom(
  child: BrickArtifact,
  ancestor: BrickId,
  store: ForgeStore,
  options?: IsDerivedFromOptions,
): Promise<LineageOutcome> {
  if (typeof ancestor !== "string" || !isBrickId(ancestor)) {
    return { kind: "malformed", reason: "ancestor is not a canonical BrickId" };
  }
  const childShape = inspectLineageShape(child);
  if (childShape.kind === "malformed") {
    return { kind: "malformed", reason: childShape.reason };
  }
  // When verification is requested, integrity-verify the child itself
  // before trusting its `parentBrickId`. Otherwise a tampered child whose
  // provenance points at a trusted ancestor would be accepted as derived.
  if (options !== undefined) {
    const childVerdict = options.verify(child, options.producerBuilderId);
    if (childVerdict.kind !== "ok") {
      return {
        kind: "integrity_failed",
        at: childShape.id,
        producerBuilderId: options.producerBuilderId,
        reason: childVerdict.kind,
      };
    }
  }

  const seen = new Set<BrickId>([childShape.id]);
  let parentId = childShape.parentBrickId;
  let steps = 0;

  while (parentId !== undefined) {
    if (seen.has(parentId)) return { kind: "cycle_detected", at: parentId };
    if (steps >= MAX_LINEAGE_DEPTH) return { kind: "depth_exceeded", depth: steps };
    seen.add(parentId);
    // Do NOT short-circuit on `parentId === ancestor` before loading and
    // (when verification is requested) integrity-verifying that ancestor
    // record. Otherwise a tampered child could rewrite its own
    // `parentBrickId` to a trusted ancestor and forge a positive result.

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
    // Bind the response to the requested id: a corrupt/stale/cache-confused
    // store returning a different brick must not let us traverse a foreign
    // ancestry chain. Fail closed as malformed at the boundary.
    if (loadedShape.id !== parentId) {
      return {
        kind: "malformed",
        at: parentId,
        reason: `store returned brick with id ${loadedShape.id}, expected ${parentId}`,
      };
    }
    if (options !== undefined) {
      const verdict = options.verify(result.value, options.producerBuilderId);
      if (verdict.kind !== "ok") {
        return {
          kind: "integrity_failed",
          at: parentId,
          producerBuilderId: options.producerBuilderId,
          reason: verdict.kind,
        };
      }
    }
    if (parentId === ancestor) return { kind: "derived" };
    parentId = loadedShape.parentBrickId;
    steps += 1;
  }
  return { kind: "not_derived" };
}

/**
 * Returns the first brick in `bricks` whose stored `id` equals `candidateId`
 * AND whose recomputed identity passes `verify` for the named producer.
 *
 * Stored bricks can claim any `provenance.builder.id`; equality of `BrickId`
 * alone is not safe as a cross-producer dedup key, and the claimed builder
 * is read from the unverified artifact. We therefore require the caller to
 * supply a `BrickVerifier` and only treat a candidate as a duplicate if the
 * stored brick verifies as `ok` under the expected producer's scheme. A
 * poisoned store entry that squats on a candidate id but cannot recompute
 * to the same canonical content is rejected.
 */
export function findDuplicateById(
  bricks: readonly BrickArtifact[],
  candidateId: BrickId,
  producerBuilderId: string,
  verify: BrickVerifier,
): BrickArtifact | undefined {
  return bricks.find((b) => {
    if (b.id !== candidateId) return false;
    const result = verify(b, producerBuilderId);
    return result.kind === "ok";
  });
}
