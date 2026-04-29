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
import type { BrickVerifier, IntegrityResult } from "./integrity.js";

/** Maximum lineage walk depth — prevents infinite loops on malformed chains. */
export const MAX_LINEAGE_DEPTH = 64;

export type LineageOutcome =
  | { readonly kind: "derived" }
  | { readonly kind: "not_derived" }
  | { readonly kind: "depth_exceeded"; readonly depth: number }
  | { readonly kind: "cycle_detected"; readonly at: BrickId }
  | { readonly kind: "missing_link"; readonly at: BrickId; readonly error: KoiError }
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
   * dedup. The child AND every loaded ancestor are verified under the
   * single `producerBuilderId` declared here — selecting a verifier from
   * each ancestor's self-asserted `provenance.builder.id` would let a
   * tampered record self-select a more permissive registered recompute.
   * Cross-producer lineage requires authenticated builder-transition
   * records, which are out of scope for this package.
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

const ALLOWED_EVOLUTION_KINDS = new Set(["fix", "derived", "captured"]);

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
  // Enforce createForgeProvenance's both-or-neither invariant: if a parent
  // is present, evolutionKind must also be present and a known value. A
  // record returned by the store with one but not the other is corrupt
  // (partial migration, version skew, tamper) and must surface as
  // malformed before any lineage decision is made on it.
  const evolutionKind = provenance.evolutionKind;
  const hasParent = parent !== undefined;
  const hasEvolutionKind = evolutionKind !== undefined;
  if (hasParent !== hasEvolutionKind) {
    return {
      kind: "malformed",
      reason: "brick.provenance.parentBrickId and evolutionKind must be both set or both omitted",
    };
  }
  if (hasEvolutionKind && !ALLOWED_EVOLUTION_KINDS.has(evolutionKind as string)) {
    return {
      kind: "malformed",
      reason: `brick.provenance.evolutionKind "${String(evolutionKind)}" is not a known value`,
    };
  }
  return { kind: "ok", id: brick.id, parentBrickId: parent };
}

/**
 * Walks the `parentBrickId` chain upwards from `child` to determine whether
 * `ancestor` is in its lineage, integrity-verifying every brick along the
 * way. Surfaces the reason for a non-positive answer so callers can
 * distinguish a true non-lineage relationship from a store outage, a depth
 * overrun, a malformed record, a cycle, or a failed integrity check.
 *
 * `options.verify` + `options.producerBuilderId` are REQUIRED. The child is
 * verified under `producerBuilderId`; each loaded ancestor is verified
 * under its own claimed builder.id. Use `isDerivedFromUnchecked` only if
 * you have an explicit, audited reason to skip integrity verification — a
 * stale/corrupt/adversarial record stored under a real brick id can
 * rewrite its parent pointer and silently mislead an unverified walk.
 */
export async function isDerivedFrom(
  child: BrickArtifact,
  ancestor: BrickId,
  store: ForgeStore,
  options: IsDerivedFromOptions,
): Promise<LineageOutcome> {
  const optionsCheck = validateOptions(options);
  if (optionsCheck !== undefined) return optionsCheck;
  return walk(child, ancestor, store, options);
}

/**
 * Unverified lineage walk — the legacy 3-arg form. Caller MUST treat the
 * result as untrusted. Intended only for narrow contexts (debug tools,
 * UI hints, pre-verification triage) where the caller does not gate
 * policy/dedup decisions on the outcome. Production trust paths must use
 * `isDerivedFrom`.
 */
export async function isDerivedFromUnchecked(
  child: BrickArtifact,
  ancestor: BrickId,
  store: ForgeStore,
): Promise<LineageOutcome> {
  return walk(child, ancestor, store, undefined);
}

function validateOptions(options: unknown): LineageOutcome | undefined {
  if (options === null || typeof options !== "object") {
    return { kind: "malformed", reason: "options is not an object" };
  }
  const o = options as Partial<IsDerivedFromOptions>;
  if (typeof o.verify !== "function") {
    return { kind: "malformed", reason: "options.verify is not a function" };
  }
  if (typeof o.producerBuilderId !== "string" || o.producerBuilderId.length === 0) {
    return { kind: "malformed", reason: "options.producerBuilderId must be a non-empty string" };
  }
  return undefined;
}

async function walk(
  child: BrickArtifact,
  ancestor: BrickId,
  store: ForgeStore,
  options: IsDerivedFromOptions | undefined,
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
    // The producer's canonical recompute must cover lineage fields (parent
    // pointer, evolution kind) before this walk can be trusted. Without
    // that operator-supplied declaration an attacker can rewrite
    // `parentBrickId` while keeping `brick.id` valid under a content-only
    // recompute, and the walk would still report `derived`. Fail closed.
    if (!coversLineageSafe(options.verify, options.producerBuilderId)) {
      return {
        kind: "integrity_failed",
        at: childShape.id,
        producerBuilderId: options.producerBuilderId,
        reason: "lineage_unbound",
      };
    }
    const childVerdict = safeVerify(options.verify, child, options.producerBuilderId);
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
    // Validate the resolved Result shape before dereferencing. A buggy or
    // version-skewed store that resolves null/undefined or omits `ok`/
    // `error`/`value` must surface as a typed malformed outcome rather
    // than crashing the caller on the trust boundary.
    if (result === null || typeof result !== "object" || typeof result.ok !== "boolean") {
      return {
        kind: "malformed",
        at: parentId,
        reason: "store.load resolved a non-Result payload",
      };
    }
    if (!result.ok) {
      const err = result.error;
      if (err === null || typeof err !== "object" || typeof err.code !== "string") {
        return {
          kind: "malformed",
          at: parentId,
          reason: "store.load returned ok:false with malformed error",
        };
      }
      // Distinguish a legitimately-absent ancestor (cache eviction, lagging
      // replica, partial store) from a transport/backend failure. Callers
      // that need to fail-closed on either can collapse the cases; callers
      // that retain only recent ancestry can treat `missing_link` as
      // expected and surface a less alarming outcome to operators.
      if (err.code === "NOT_FOUND") {
        return { kind: "missing_link", at: parentId, error: err };
      }
      return { kind: "store_error", at: parentId, error: err };
    }

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
      // Verify each ancestor under the SAME `producerBuilderId` the caller
      // declared up front. Selecting a verifier from the loaded ancestor's
      // own `provenance.builder.id` would let a tampered record self-select
      // a more permissive registered recompute and pass. Mixed-producer
      // lineage requires authenticated builder-transition records, which
      // are out of scope for this package; until that exists, a single
      // trusted producer per chain is the only sound model.
      const verdict = safeVerify(options.verify, result.value, options.producerBuilderId);
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
 * Returns the first brick in `bricks` whose canonical *content* matches
 * `candidate` under the named producer's recompute.
 *
 * **NOT a trust-equivalence helper.** A producer's canonical id covers
 * artifact content (name/version/scope/owner/implementation) but does NOT
 * cover provenance fields such as `classification`, `contentMarkers`, or
 * `verification`. Two bricks with the same id can therefore differ in
 * sensitivity or verification state. Callers must NOT use this result as
 * grounds to substitute a stored brick for a candidate when classification
 * or verification metadata could matter — compare those fields explicitly,
 * or model the decision at a higher layer that has access to the trust
 * policy.
 *
 * Verifying the candidate first prevents an attacker-controlled artifact
 * from aliasing onto a trusted stored brick by id alone. A poisoned store
 * entry that squats on a candidate id but cannot recompute to the same
 * canonical content is rejected by the per-stored verification.
 */
export function findContentEquivalentById(
  bricks: readonly BrickArtifact[],
  candidate: BrickArtifact,
  producerBuilderId: string,
  verify: BrickVerifier,
): BrickArtifact | undefined {
  const candidateVerdict = safeVerify(verify, candidate, producerBuilderId);
  if (candidateVerdict.kind !== "ok") return undefined;
  const candidateId = candidate.id;
  return bricks.find((b) => {
    if (b.id !== candidateId) return false;
    const result = safeVerify(verify, b, producerBuilderId);
    return result.kind === "ok";
  });
}

/**
 * Defensively probe the verifier's `coversLineage` declaration. A custom
 * verifier may not implement the property, or its `coversLineage` may
 * throw; in either case we fail closed (false) so lineage walks never
 * trust a producer that hasn't been explicitly declared lineage-bound.
 */
function coversLineageSafe(verify: BrickVerifier, builderId: string): boolean {
  try {
    const fn = (verify as { coversLineage?: unknown }).coversLineage;
    if (typeof fn !== "function") return false;
    const result = fn.call(verify, builderId);
    return result === true;
  } catch {
    return false;
  }
}

/**
 * Invoke a caller-supplied `BrickVerifier` defensively. The verifier may be
 * a custom implementation, not necessarily one minted by `createBrickVerifier`,
 * so a synchronous throw or a non-result return must not escape into the
 * caller. Both are normalized to `recompute_failed` so the surrounding
 * helper surfaces `integrity_failed` / undefined rather than crashing on
 * the trust boundary during exactly the check that should fail closed.
 */
function safeVerify(
  verify: BrickVerifier,
  brick: BrickArtifact,
  expectedBuilderId: string,
): IntegrityResult {
  let raw: unknown;
  try {
    raw = verify(brick, expectedBuilderId);
  } catch (err: unknown) {
    return {
      kind: "recompute_failed",
      ok: false,
      brickId:
        typeof brick?.id === "string" ? (brick.id as BrickId) : ("sha256:unknown" as BrickId),
      builderId: expectedBuilderId,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (!isWellFormedIntegrityResult(raw)) {
    return {
      kind: "recompute_failed",
      ok: false,
      brickId:
        typeof brick?.id === "string" ? (brick.id as BrickId) : ("sha256:unknown" as BrickId),
      builderId: expectedBuilderId,
      reason: "verifier returned a non-IntegrityResult value",
    };
  }
  return raw;
}

/**
 * Validate the full `IntegrityResult` discriminated-union shape rather
 * than trusting an arbitrary `{ kind: string }`. A custom or version-
 * skewed verifier might otherwise return `{ kind: "ok" }` (without
 * `ok: true`) and bypass the integrity gate. We require the discriminant
 * AND its companion `ok` boolean to be consistent before treating the
 * verdict as authoritative.
 */
function isWellFormedIntegrityResult(raw: unknown): raw is IntegrityResult {
  if (raw === null || typeof raw !== "object") return false;
  const r = raw as { readonly kind?: unknown; readonly ok?: unknown };
  if (typeof r.kind !== "string") return false;
  switch (r.kind) {
    case "ok":
      return r.ok === true;
    case "content_mismatch":
    case "producer_mismatch":
    case "producer_unknown":
    case "recompute_failed":
    case "malformed":
      return r.ok === false;
    default:
      return false;
  }
}
