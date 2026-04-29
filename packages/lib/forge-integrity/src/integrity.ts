/**
 * Content-addressed integrity verification.
 *
 * Recomputes a brick's content-addressed `BrickId` and compares it to the
 * stored value. Identity IS integrity — a brick whose content has been
 * tampered with will hash to a different ID.
 */

import type { BrickArtifact, BrickId } from "@koi/core";
import { computeBrickId } from "@koi/hash";
import { extractBrickContent } from "./extract-content.js";

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

export type IntegrityResult = IntegrityOk | IntegrityContentMismatch;

export function verifyBrickIntegrity(brick: BrickArtifact): IntegrityResult {
  const { content } = extractBrickContent(brick);
  const recomputedId = computeBrickId(brick.kind, content, brick.files);

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
