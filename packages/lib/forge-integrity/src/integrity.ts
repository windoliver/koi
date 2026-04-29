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
  // Own-property lookup only — prototype-chain entries are rejected so a
  // polluted prototype cannot supply a trusted recompute by inheritance.
  if (!Object.hasOwn(registry, expectedBuilderId)) {
    return { kind: "producer_unknown", ok: false, brickId: shape.id, expectedBuilderId };
  }
  const recompute = registry[expectedBuilderId];
  if (typeof recompute !== "function") {
    return { kind: "producer_unknown", ok: false, brickId: shape.id, expectedBuilderId };
  }

  let recomputedId: BrickId;
  try {
    recomputedId = recompute(brick);
  } catch (err: unknown) {
    return {
      kind: "recompute_failed",
      ok: false,
      brickId: shape.id,
      builderId: expectedBuilderId,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

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
