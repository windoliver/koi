/**
 * Content integrity verification — recomputes content-addressed BrickId
 * and compares to the stored `id`. Identity IS integrity.
 */

import type { BrickArtifact, BrickId, ForgeStore, Result, SigningBackend } from "@koi/core";
import type { ForgeError } from "@koi/forge-types";
import { storeError } from "@koi/forge-types";
import { computeBrickId } from "@koi/hash";
import { verifyAttestation } from "./attestation.js";
import { extractBrickContent } from "./brick-content.js";

// ---------------------------------------------------------------------------
// Result types — 3-variant discriminated union
// ---------------------------------------------------------------------------

export interface IntegrityOk {
  readonly kind: "ok";
  readonly ok: true;
  readonly brickId: BrickId;
  readonly id: BrickId;
}

export interface IntegrityContentMismatch {
  readonly kind: "content_mismatch";
  readonly ok: false;
  readonly brickId: BrickId;
  readonly expectedId: BrickId;
  readonly actualId: BrickId;
}

export interface IntegrityAttestationFailed {
  readonly kind: "attestation_failed";
  readonly ok: false;
  readonly brickId: BrickId;
  readonly reason: "missing" | "invalid" | "algorithm_mismatch";
}

export type IntegrityResult = IntegrityOk | IntegrityContentMismatch | IntegrityAttestationFailed;

// ---------------------------------------------------------------------------
// Pure — recomputes ID from content and compares to stored id
// ---------------------------------------------------------------------------

/**
 * Verifies that a brick's content has not been tampered with by recomputing
 * the content-addressed BrickId and comparing it to the stored `id`.
 */
export function verifyBrickIntegrity(brick: BrickArtifact): IntegrityResult {
  const { content } = extractBrickContent(brick);
  const recomputedId: BrickId = computeBrickId(brick.kind, content, brick.files);

  if (recomputedId === brick.id) {
    return { kind: "ok", ok: true, brickId: brick.id, id: recomputedId };
  }

  return {
    kind: "content_mismatch",
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
        kind: "attestation_failed",
        ok: false,
        brickId: brick.id,
        reason: "invalid",
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
