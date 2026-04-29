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
 * `expectedBuilderId`, otherwise the result is `producer_mismatch` — this
 * prevents callers from being misled by an artifact that claims a different
 * producer than the trust context they invoked verification under.
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
  readonly expectedId: BrickId;
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

export type IntegrityResult =
  | IntegrityOk
  | IntegrityContentMismatch
  | IntegrityProducerMismatch
  | IntegrityProducerUnknown
  | IntegrityRecomputeFailed;

/** Pure recompute function — must match the producer's canonical scheme. */
export type RecomputeBrickId = (brick: BrickArtifact) => BrickId;

/** Registry mapping `provenance.builder.id` to the producer's recompute. */
export type ProducerRegistry = Readonly<Record<string, RecomputeBrickId>>;

/**
 * Verify a brick by looking up the recompute function registered for the
 * caller-supplied `expectedBuilderId`, then asserting that the artifact's
 * self-asserted `provenance.builder.id` matches the same value. Fails closed
 * on every mismatch — callers cannot supply an arbitrary callback, and an
 * artifact cannot dictate which producer's scheme is applied.
 *
 * Note: a successful result proves content-consistency under the expected
 * producer's identity scheme, NOT cryptographic authenticity. Producer
 * authenticity requires a separate attestation/signature verification.
 */
export function verifyBrickIntegrity(
  brick: BrickArtifact,
  registry: ProducerRegistry,
  expectedBuilderId: string,
): IntegrityResult {
  const claimedBuilderId = brick.provenance.builder.id;
  if (claimedBuilderId !== expectedBuilderId) {
    return {
      kind: "producer_mismatch",
      ok: false,
      brickId: brick.id,
      expectedBuilderId,
      claimedBuilderId,
    };
  }
  const recompute = registry[expectedBuilderId];
  if (recompute === undefined) {
    return { kind: "producer_unknown", ok: false, brickId: brick.id, expectedBuilderId };
  }

  let recomputedId: BrickId;
  try {
    recomputedId = recompute(brick);
  } catch (err: unknown) {
    return {
      kind: "recompute_failed",
      ok: false,
      brickId: brick.id,
      builderId: expectedBuilderId,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (recomputedId === brick.id) {
    return { kind: "ok", ok: true, brickId: brick.id, builderId: expectedBuilderId };
  }
  return {
    kind: "content_mismatch",
    ok: false,
    brickId: brick.id,
    expectedId: brick.id,
    actualId: recomputedId,
    builderId: expectedBuilderId,
  };
}
