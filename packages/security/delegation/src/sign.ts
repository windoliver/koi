/**
 * HMAC-SHA256 signing and verification for delegation grants.
 *
 * Uses Bun-native crypto (Node.js crypto module). Proof is computed
 * over a canonical JSON representation of the grant payload (excluding
 * the proof field itself).
 *
 * DelegationGrant.proof is now a CapabilityProof discriminated union.
 * This module handles the `kind: "hmac-sha256"` variant.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { CapabilityProof, DelegationGrant } from "@koi/core";
import { canonicalize } from "@koi/crypto-utils";

/** All grant fields except `proof`, serialized in deterministic key order. */
type UnsignedGrant = Omit<DelegationGrant, "proof">;

/**
 * Signs an unsigned grant payload with HMAC-SHA256.
 * Returns a CapabilityProof with kind="hmac-sha256".
 */
export function signGrant(payload: UnsignedGrant, secret: string): CapabilityProof {
  const canonical = canonicalize(payload);
  const digest = createHmac("sha256", secret).update(canonical).digest("hex");
  return { kind: "hmac-sha256", digest };
}

/**
 * Verifies a delegation grant's HMAC-SHA256 proof.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * Results are cached via WeakMap keyed by grant object reference.
 * Grants are immutable — same object reference always produces the same
 * result. The WeakMap is GC-friendly (entries are collected when the grant
 * object is no longer referenced).
 *
 * SHA256 always produces 64 hex chars. The length check is safe because
 * `expected` is always 64 chars — the early exit only triggers for
 * malformed proofs (not a timing oracle).
 *
 * Returns false if the proof is not of kind "hmac-sha256".
 */
const verifyCache = new WeakMap<DelegationGrant, boolean>();

export function verifySignature(grant: DelegationGrant, secret: string): boolean {
  const cached = verifyCache.get(grant);
  if (cached !== undefined) {
    return cached;
  }

  const result = verifySignatureUncached(grant, secret);
  verifyCache.set(grant, result);
  return result;
}

function verifySignatureUncached(grant: DelegationGrant, secret: string): boolean {
  if (grant.proof.kind !== "hmac-sha256") {
    return false;
  }

  const digest = grant.proof.digest;
  const EXPECTED_HEX_LENGTH = 64;

  if (digest.length !== EXPECTED_HEX_LENGTH) {
    return false;
  }

  const { proof: _proof, ...unsigned } = grant;
  const expectedProof = signGrant(unsigned, secret);

  if (expectedProof.kind !== "hmac-sha256") {
    return false;
  }

  try {
    return timingSafeEqual(
      new Uint8Array(Buffer.from(expectedProof.digest, "hex")),
      new Uint8Array(Buffer.from(digest, "hex")),
    );
  } catch {
    return false;
  }
}
