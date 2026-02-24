/**
 * Content integrity verification — recomputes SHA-256 hash and compares
 * to the stored `contentHash` on a brick artifact.
 */

import type { BrickArtifact, ForgeStore, Result } from "@koi/core";
import type { ForgeError } from "./errors.js";
import { storeError } from "./errors.js";
import { computeContentHash } from "./tools/shared.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface IntegrityOk {
  readonly ok: true;
  readonly brickId: string;
  readonly hash: string;
}

export interface IntegrityMismatch {
  readonly ok: false;
  readonly brickId: string;
  readonly expectedHash: string;
  readonly actualHash: string;
}

export type IntegrityResult = IntegrityOk | IntegrityMismatch;

// ---------------------------------------------------------------------------
// Content extraction per brick kind
// ---------------------------------------------------------------------------

function extractContentForHash(brick: BrickArtifact): string {
  switch (brick.kind) {
    case "tool":
      return brick.implementation;
    case "skill":
      return brick.content;
    case "agent":
      return brick.manifestYaml;
    case "composite":
      return brick.brickIds.join(",");
  }
}

// ---------------------------------------------------------------------------
// Pure — recomputes hash and compares to stored
// ---------------------------------------------------------------------------

/**
 * Verifies that a brick's content has not been tampered with by recomputing
 * the SHA-256 content hash and comparing it to the stored `contentHash`.
 */
export function verifyBrickIntegrity(brick: BrickArtifact): IntegrityResult {
  const content = extractContentForHash(brick);
  const actualHash = computeContentHash(content, brick.files);

  if (actualHash === brick.contentHash) {
    return { ok: true, brickId: brick.id, hash: actualHash };
  }

  return {
    ok: false,
    brickId: brick.id,
    expectedHash: brick.contentHash,
    actualHash,
  };
}

// ---------------------------------------------------------------------------
// Convenience — load from store + verify in one call
// ---------------------------------------------------------------------------

/**
 * Loads a brick from the store and verifies its content integrity.
 *
 * Returns the brick alongside the integrity result even when integrity fails.
 * Only store-level failures produce a `ForgeError`.
 */
export async function loadAndVerify(
  store: ForgeStore,
  id: string,
): Promise<
  Result<{ readonly brick: BrickArtifact; readonly integrity: IntegrityResult }, ForgeError>
> {
  const loadResult = await store.load(id);
  if (!loadResult.ok) {
    return { ok: false, error: storeError("LOAD_FAILED", loadResult.error.message) };
  }

  const brick = loadResult.value;
  const integrity = verifyBrickIntegrity(brick);

  return { ok: true, value: { brick, integrity } };
}
