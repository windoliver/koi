/**
 * Content-addressed integrity verification.
 *
 * Recomputes a brick's content-addressed `BrickId` via a caller-supplied
 * recompute function and compares it to the stored value. Identity IS
 * integrity — a brick whose identity-bearing content has been tampered
 * with will hash to a different ID.
 *
 * The canonical identity scheme is owned by the package that produced the
 * brick (e.g. `@koi/forge-tools`'s `recomputeBrickIdFromArtifact`). This
 * package does NOT define its own scheme: doing so would silently diverge
 * from producers and reject valid persisted artifacts. Callers must pass
 * the same recompute function the producer used at synthesis time.
 */

import type { BrickArtifact, BrickId } from "@koi/core";

export interface IntegrityOk {
  readonly kind: "ok";
  readonly ok: true;
  readonly brickId: BrickId;
}

export interface IntegrityContentMismatch {
  readonly kind: "content_mismatch";
  readonly ok: false;
  readonly brickId: BrickId;
  readonly expectedId: BrickId;
  readonly actualId: BrickId;
}

export interface IntegrityRecomputeFailed {
  readonly kind: "recompute_failed";
  readonly ok: false;
  readonly brickId: BrickId;
  readonly reason: string;
}

export type IntegrityResult = IntegrityOk | IntegrityContentMismatch | IntegrityRecomputeFailed;

/** Pure recompute function — must match the producer's canonical scheme. */
export type RecomputeBrickId = (brick: BrickArtifact) => BrickId;

export function verifyBrickIntegrity(
  brick: BrickArtifact,
  recompute: RecomputeBrickId,
): IntegrityResult {
  let recomputedId: BrickId;
  try {
    recomputedId = recompute(brick);
  } catch (err: unknown) {
    return {
      kind: "recompute_failed",
      ok: false,
      brickId: brick.id,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (recomputedId === brick.id) {
    return { kind: "ok", ok: true, brickId: brick.id };
  }
  return {
    kind: "content_mismatch",
    ok: false,
    brickId: brick.id,
    expectedId: brick.id,
    actualId: recomputedId,
  };
}
