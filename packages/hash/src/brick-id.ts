/**
 * Content-addressed BrickId computation.
 *
 * BrickId = SHA-256(kind + primary content + sorted files).
 * Format: "sha256:<64-char-hex>"
 *
 * Identical content always produces the same BrickId — free deduplication.
 * Composite bricks use sorted child IDs for order-independent Merkle identity.
 */

import type { BrickId } from "@koi/core";
import { brickId } from "@koi/core";

/** Prefix for all content-addressed BrickIds. */
const BRICK_ID_PREFIX = "sha256:";

/** Regex matching the canonical BrickId format: `sha256:<64-hex-chars>`. */
const BRICK_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Compute a content-addressed BrickId from brick content.
 *
 * Hash inputs: `kind + ":" + content`, then sorted file keys and values.
 * Format: `sha256:<64-char-hex>`.
 */
export function computeBrickId(
  kind: string,
  content: string,
  files?: Readonly<Record<string, string>>,
): BrickId {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${kind}:${content}`);
  feedFiles(hasher, files);
  return brickId(BRICK_ID_PREFIX + hasher.digest("hex"));
}

/**
 * Compute a content-addressed BrickId for a composite (Merkle hash of children).
 *
 * Child IDs are sorted lexicographically for order-independent identity.
 * Format: `sha256:<64-char-hex>`.
 */
export function computeCompositeBrickId(
  childIds: readonly BrickId[],
  files?: Readonly<Record<string, string>>,
): BrickId {
  const sorted = [...childIds].sort();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`composite:${sorted.join(",")}`);
  feedFiles(hasher, files);
  return brickId(BRICK_ID_PREFIX + hasher.digest("hex"));
}

/**
 * Compute a content-addressed BrickId for a pipeline (order-preserving).
 *
 * Unlike `computeCompositeBrickId` which sorts children (order-independent),
 * pipeline identity preserves step order: A→B differs from B→A.
 * Format: `sha256:<64-char-hex>`.
 */
export function computePipelineBrickId(
  stepIds: readonly BrickId[],
  outputKind: string,
  files?: Readonly<Record<string, string>>,
): BrickId {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`pipeline:${outputKind}:${stepIds.join(",")}`);
  feedFiles(hasher, files);
  return brickId(BRICK_ID_PREFIX + hasher.digest("hex"));
}

/**
 * Type guard — validates that a string has the `sha256:<64-hex-chars>` format.
 */
export function isBrickId(value: string): value is BrickId {
  return BRICK_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function feedFiles(
  hasher: InstanceType<typeof Bun.CryptoHasher>,
  files: Readonly<Record<string, string>> | undefined,
): void {
  if (files === undefined) {
    return;
  }
  const sortedKeys = Object.keys(files).sort();
  for (const key of sortedKeys) {
    hasher.update(key);
    const value = files[key];
    if (value !== undefined) {
      hasher.update(value);
    }
  }
}
