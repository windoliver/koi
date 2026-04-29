/**
 * Content-addressed integrity verification.
 *
 * **Scope: content-consistency only.** A successful result proves only that
 * the brick's stored `id` matches the canonical recomputation under the
 * expected producer's identity scheme. It does NOT establish producer
 * authenticity — `provenance.builder.id` is read from the unverified
 * artifact, so a brick fabricated under a trusted producer's name will pass
 * here. Producer authenticity requires a separate signed-attestation check
 * (out of scope for this package).
 *
 * The canonical identity scheme is owned by the producer (e.g.
 * `@koi/forge-tools`'s `recomputeBrickIdFromArtifact`). Callers register the
 * recompute functions for the producers they trust, and the verifier picks
 * the one matching the `expectedBuilderId` supplied out-of-band by the
 * caller. The artifact's self-asserted `provenance.builder.id` must match
 * `expectedBuilderId`; otherwise the result is `producer_mismatch`.
 *
 * The verifier is hardened against malformed input (missing or wrong-shape
 * `provenance`/`builder` fields) and prototype pollution (registry lookup is
 * an own-property check, not a prototype-chain walk) so it cannot be tricked
 * into invoking an attacker-controlled recompute or crashing the caller on
 * the bad-input path.
 */

import type { BrickArtifact, BrickId } from "@koi/core";

export interface IntegrityOk {
  readonly kind: "ok";
  readonly ok: true;
  readonly brickId: BrickId;
  readonly builderId: string;
}

export interface IntegrityContentMismatch {
  readonly kind: "content_mismatch";
  readonly ok: false;
  readonly brickId: BrickId;
  /** The id the trusted producer's recomputation produced (canonical). */
  readonly expectedId: BrickId;
  /** The id stored on the artifact (potentially tampered). */
  readonly actualId: BrickId;
  readonly builderId: string;
}

export interface IntegrityProducerMismatch {
  readonly kind: "producer_mismatch";
  readonly ok: false;
  readonly brickId: BrickId;
  readonly expectedBuilderId: string;
  readonly claimedBuilderId: string;
}

export interface IntegrityProducerUnknown {
  readonly kind: "producer_unknown";
  readonly ok: false;
  readonly brickId: BrickId;
  readonly expectedBuilderId: string;
}

export interface IntegrityRecomputeFailed {
  readonly kind: "recompute_failed";
  readonly ok: false;
  readonly brickId: BrickId;
  readonly builderId: string;
  readonly reason: string;
}

export interface IntegrityMalformed {
  readonly kind: "malformed";
  readonly ok: false;
  readonly reason: string;
}

export type IntegrityResult =
  | IntegrityOk
  | IntegrityContentMismatch
  | IntegrityProducerMismatch
  | IntegrityProducerUnknown
  | IntegrityRecomputeFailed
  | IntegrityMalformed;

/** Pure recompute function — must match the producer's canonical scheme. */
export type RecomputeBrickId = (brick: BrickArtifact) => BrickId;

/** Registry mapping `provenance.builder.id` to the producer's recompute. */
export type ProducerRegistry = Readonly<Record<string, RecomputeBrickId>>;

/**
 * Verifier function bound to a frozen, validated `ProducerRegistry`. The
 * recommended entry point for callers — the registry is owned by the
 * operator at construction time, not passed at every call site. Returned
 * verifiers cannot be coerced to use a different registry.
 */
export type BrickVerifier = (brick: BrickArtifact, expectedBuilderId: string) => IntegrityResult;

/**
 * Build a `BrickVerifier` bound to an immutable copy of `registry`. Each
 * entry is validated upfront (must be a function); the registry itself is
 * frozen and the verifier closure prevents callers from substituting one.
 *
 * Throws synchronously on construction if `registry` is malformed.
 */
export function createBrickVerifier(registry: ProducerRegistry): BrickVerifier {
  if (registry === null || typeof registry !== "object") {
    throw new Error("createBrickVerifier: registry must be an object");
  }
  const owned: Record<string, RecomputeBrickId> = Object.create(null);
  for (const [k, v] of Object.entries(registry)) {
    if (typeof v !== "function") {
      throw new Error(`createBrickVerifier: registry["${k}"] is not a function`);
    }
    owned[k] = v;
  }
  const frozen: ProducerRegistry = Object.freeze(owned);
  return (brick, expectedBuilderId) => verifyBrickIntegrity(brick, frozen, expectedBuilderId);
}

interface ArtifactShape {
  readonly id: BrickId;
  readonly claimedBuilderId: string;
}

function inspectArtifactShape(brick: BrickArtifact): ArtifactShape | string {
  if (brick === null || typeof brick !== "object") return "brick is not an object";
  if (typeof brick.id !== "string" || brick.id.length === 0) return "brick.id missing or empty";
  const provenance = brick.provenance;
  if (provenance === null || typeof provenance !== "object") {
    return "brick.provenance missing or not an object";
  }
  const builder = provenance.builder;
  if (builder === null || typeof builder !== "object") {
    return "brick.provenance.builder missing or not an object";
  }
  if (typeof builder.id !== "string" || builder.id.length === 0) {
    return "brick.provenance.builder.id missing or empty";
  }
  return { id: brick.id, claimedBuilderId: builder.id };
}

export function verifyBrickIntegrity(
  brick: BrickArtifact,
  registry: ProducerRegistry,
  expectedBuilderId: string,
): IntegrityResult {
  const shape = inspectArtifactShape(brick);
  if (typeof shape === "string") {
    return { kind: "malformed", ok: false, reason: shape };
  }
  if (shape.claimedBuilderId !== expectedBuilderId) {
    return {
      kind: "producer_mismatch",
      ok: false,
      brickId: shape.id,
      expectedBuilderId,
      claimedBuilderId: shape.claimedBuilderId,
    };
  }
  // Defend against a misconfigured/version-skewed registry argument: a null
  // or non-object registry must fail closed rather than throwing inside
  // Object.hasOwn and crashing the caller on the security boundary.
  if (registry === null || typeof registry !== "object") {
    return { kind: "malformed", ok: false, reason: "registry is not an object" };
  }
  // Own-property lookup only — prototype-chain entries are rejected so a
  // polluted prototype cannot supply a trusted recompute by inheritance.
  if (!Object.hasOwn(registry, expectedBuilderId)) {
    return { kind: "producer_unknown", ok: false, brickId: shape.id, expectedBuilderId };
  }
  const recompute = registry[expectedBuilderId];
  if (typeof recompute !== "function") {
    return { kind: "producer_unknown", ok: false, brickId: shape.id, expectedBuilderId };
  }

  let recomputedRaw: unknown;
  try {
    recomputedRaw = recompute(brick);
  } catch (err: unknown) {
    return {
      kind: "recompute_failed",
      ok: false,
      brickId: shape.id,
      builderId: expectedBuilderId,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  // Reject promises and non-string returns: this verifier's contract is
  // synchronous, and a Promise/object recompute would otherwise silently
  // fail the `===` check and surface as a misleading content_mismatch.
  if (recomputedRaw !== null && typeof recomputedRaw === "object" && "then" in recomputedRaw) {
    return {
      kind: "recompute_failed",
      ok: false,
      brickId: shape.id,
      builderId: expectedBuilderId,
      reason: "recompute returned a Promise; only sync recomputers are supported",
    };
  }
  if (typeof recomputedRaw !== "string" || recomputedRaw.length === 0) {
    return {
      kind: "recompute_failed",
      ok: false,
      brickId: shape.id,
      builderId: expectedBuilderId,
      reason: "recompute did not return a non-empty BrickId string",
    };
  }
  const recomputedId = recomputedRaw as BrickId;

  if (recomputedId === shape.id) {
    return { kind: "ok", ok: true, brickId: shape.id, builderId: expectedBuilderId };
  }
  return {
    kind: "content_mismatch",
    ok: false,
    brickId: shape.id,
    // Canonical (trusted) value is what the producer's recompute produced;
    // the artifact's stored id is the observed/actual value to investigate.
    expectedId: recomputedId,
    actualId: shape.id,
    builderId: expectedBuilderId,
  };
}
