/**
 * Content-addressed integrity verification.
 *
 * Identity IS integrity — the canonical identity scheme is owned by the
 * package that produced the brick (e.g. `@koi/forge-tools`'s
 * `recomputeBrickIdFromArtifact`). This package never defines its own
 * scheme: doing so would silently diverge from producers and reject valid
 * persisted artifacts.
 *
 * Verification is bound to the producer named in `provenance.builder.id`:
 * callers register the recompute functions for the producers they trust,
 * and the verifier picks the one matching the brick's claimed builder.
 * This prevents arbitrary callbacks from certifying tampered bricks.
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

export interface IntegrityProducerUnknown {
  readonly kind: "producer_unknown";
  readonly ok: false;
  readonly brickId: BrickId;
  readonly builderId: string;
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
  | IntegrityProducerUnknown
  | IntegrityRecomputeFailed;

/** Pure recompute function — must match the producer's canonical scheme. */
export type RecomputeBrickId = (brick: BrickArtifact) => BrickId;

/** Registry mapping `provenance.builder.id` to the producer's recompute. */
export type ProducerRegistry = Readonly<Record<string, RecomputeBrickId>>;

/**
 * Verify a brick by looking up the recompute function registered for its
 * claimed producer (`provenance.builder.id`). Fails closed when no producer
 * matches — callers cannot supply an arbitrary callback.
 */
export function verifyBrickIntegrity(
  brick: BrickArtifact,
  registry: ProducerRegistry,
): IntegrityResult {
  const builderId = brick.provenance.builder.id;
  const recompute = registry[builderId];
  if (recompute === undefined) {
    return { kind: "producer_unknown", ok: false, brickId: brick.id, builderId };
  }

  let recomputedId: BrickId;
  try {
    recomputedId = recompute(brick);
  } catch (err: unknown) {
    return {
      kind: "recompute_failed",
      ok: false,
      brickId: brick.id,
      builderId,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (recomputedId === brick.id) {
    return { kind: "ok", ok: true, brickId: brick.id, builderId };
  }
  return {
    kind: "content_mismatch",
    ok: false,
    brickId: brick.id,
    expectedId: brick.id,
    actualId: recomputedId,
    builderId,
  };
}
