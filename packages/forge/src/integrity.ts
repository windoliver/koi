/**
 * Content integrity verification — recomputes content-addressed BrickId
 * and compares to the stored `id`. Identity IS integrity.
 */

import type { BrickArtifact, BrickId, ForgeStore, Result, SigningBackend } from "@koi/core";
import { computeBrickId, computeCompositeBrickId } from "@koi/hash";
import { verifyAttestation } from "./attestation.js";
import type { ForgeError } from "./errors.js";
import { storeError } from "./errors.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface IntegrityOk {
  readonly ok: true;
  readonly brickId: BrickId;
  readonly id: BrickId;
}

export interface IntegrityMismatch {
  readonly ok: false;
  readonly brickId: BrickId;
  readonly expectedId: BrickId;
  readonly actualId: BrickId;
}

export type IntegrityResult = IntegrityOk | IntegrityMismatch;

// ---------------------------------------------------------------------------
// Content extraction per brick kind
// ---------------------------------------------------------------------------

function extractContentForHash(brick: BrickArtifact): string {
  switch (brick.kind) {
    case "tool":
    case "engine":
    case "resolver":
    case "provider":
    case "middleware":
    case "channel":
      return brick.implementation;
    case "skill":
      return brick.content;
    case "agent":
      return brick.manifestYaml;
    case "composite":
      // Composite uses computeCompositeBrickId — sentinel here
      return "";
  }
}

// ---------------------------------------------------------------------------
// Pure — recomputes ID from content and compares to stored id
// ---------------------------------------------------------------------------

/**
 * Verifies that a brick's content has not been tampered with by recomputing
 * the content-addressed BrickId and comparing it to the stored `id`.
 */
export function verifyBrickIntegrity(brick: BrickArtifact): IntegrityResult {
  const recomputedId: BrickId =
    brick.kind === "composite"
      ? computeCompositeBrickId(brick.brickIds, brick.files)
      : computeBrickId(brick.kind, extractContentForHash(brick), brick.files);

  if (recomputedId === brick.id) {
    return { ok: true, brickId: brick.id, id: recomputedId };
  }

  return {
    ok: false,
    brickId: brick.id,
    expectedId: brick.id,
    actualId: recomputedId,
  };
}

/**
 * Verifies both content hash integrity AND attestation signature.
 *
 * Returns the integrity result. If the brick has an attestation and a signer
 * is provided, also verifies the cryptographic signature.
 */
export async function verifyBrickAttestation(
  brick: BrickArtifact,
  signer: SigningBackend,
): Promise<IntegrityResult> {
  // First verify content hash
  const hashResult = verifyBrickIntegrity(brick);
  if (!hashResult.ok) {
    return hashResult;
  }

  // If attestation is present, verify signature
  if (brick.provenance.attestation !== undefined) {
    const signatureValid = await verifyAttestation(brick.provenance, signer);
    if (!signatureValid) {
      return {
        ok: false,
        brickId: brick.id,
        expectedId: brick.id,
        actualId: brick.id, // Content matches but attestation is invalid
      };
    }
  }

  return hashResult;
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
  id: BrickId,
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
