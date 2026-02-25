/**
 * Content integrity verification — recomputes SHA-256 hash and compares
 * to the stored `contentHash` on a brick artifact.
 */

import type { BrickArtifact, ForgeStore, Result, SigningBackend } from "@koi/core";
import { verifyAttestation } from "./attestation.js";
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
      return brick.brickIds.join(",");
  }
}

// ---------------------------------------------------------------------------
// Pure — recomputes hash and compares to stored
// ---------------------------------------------------------------------------

/**
 * Verifies that a brick's content has not been tampered with by recomputing
 * the SHA-256 content hash and comparing it to the stored `contentHash`.
 *
 * Current implementation is synchronous; return type is `IntegrityResult | Promise<IntegrityResult>`
 * to allow future async backends (await on a non-Promise is a no-op).
 */
export function verifyBrickIntegrity(
  brick: BrickArtifact,
): IntegrityResult | Promise<IntegrityResult> {
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
  const hashResult = await verifyBrickIntegrity(brick);
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
        expectedHash: brick.contentHash,
        actualHash: `attestation-invalid:${brick.contentHash}`,
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
  id: string,
): Promise<
  Result<{ readonly brick: BrickArtifact; readonly integrity: IntegrityResult }, ForgeError>
> {
  const loadResult = await store.load(id);
  if (!loadResult.ok) {
    return { ok: false, error: storeError("LOAD_FAILED", loadResult.error.message) };
  }

  const brick = loadResult.value;
  const integrity = await verifyBrickIntegrity(brick);

  return { ok: true, value: { brick, integrity } };
}
