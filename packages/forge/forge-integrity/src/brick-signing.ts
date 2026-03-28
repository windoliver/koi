/**
 * Brick signing and verification — Ed25519 cryptographic signatures for
 * forge brick trust model.
 *
 * Uses @koi/crypto-utils for the underlying Ed25519 primitives and
 * @koi/crypto-utils canonicalize for deterministic payload serialization.
 *
 * Trust tiers:
 * - "local"     — No signature, user's own forged brick.
 * - "community" — Signed by the brick author's Ed25519 key.
 * - "verified"  — Signed by a registry-trusted public key.
 */

import type { BrickSignature, Result, TrustTier } from "@koi/core";
import type { Ed25519KeyPair } from "@koi/crypto-utils";
import {
  canonicalize,
  generateEd25519KeyPair,
  signEd25519,
  verifyEd25519,
} from "@koi/crypto-utils";

// ---------------------------------------------------------------------------
// Re-export key pair type for convenience
// ---------------------------------------------------------------------------

export type { Ed25519KeyPair } from "@koi/crypto-utils";

// ---------------------------------------------------------------------------
// Brick identity payload — the fields that are signed
// ---------------------------------------------------------------------------

/** Minimal brick identity fields included in the signed payload. */
export interface BrickIdentityPayload {
  readonly contentHash: string;
  readonly kind: string;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Signing result
// ---------------------------------------------------------------------------

export interface BrickSigningError {
  readonly code: "SIGNING_FAILED";
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Verification result — discriminated union
// ---------------------------------------------------------------------------

export type BrickVerificationResult =
  | { readonly ok: true; readonly trustTier: TrustTier }
  | { readonly ok: false; readonly reason: string };

// ---------------------------------------------------------------------------
// Key generation — delegates to @koi/crypto-utils
// ---------------------------------------------------------------------------

/**
 * Generate a fresh Ed25519 key pair for brick signing.
 * Public key is SPKI DER base64, private key is PKCS8 DER base64.
 */
export function generateBrickSigningKeyPair(): Ed25519KeyPair {
  return generateEd25519KeyPair();
}

// ---------------------------------------------------------------------------
// Canonical payload — deterministic serialization for signing
// ---------------------------------------------------------------------------

/**
 * Build the canonical payload string from brick identity fields.
 * Uses sorted-key JSON serialization for determinism.
 */
export function computeSigningPayload(brick: BrickIdentityPayload): string {
  return canonicalize({
    contentHash: brick.contentHash,
    kind: brick.kind,
    name: brick.name,
  });
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

/**
 * Sign a brick's identity payload with an Ed25519 private key.
 *
 * @param brick - The brick identity fields to sign.
 * @param privateKeyDer - Base64-encoded PKCS8 DER private key.
 * @param publicKeyDer - Base64-encoded SPKI DER public key (included in signature metadata).
 * @returns Result with BrickSignature on success, BrickSigningError on failure.
 */
export function signBrick(
  brick: BrickIdentityPayload,
  privateKeyDer: string,
  publicKeyDer: string,
): Result<BrickSignature, BrickSigningError> {
  try {
    const payload = computeSigningPayload(brick);
    const signature = signEd25519(payload, privateKeyDer);

    return {
      ok: true,
      value: {
        algorithm: "ed25519",
        signature,
        publicKey: publicKeyDer,
        signedAt: Date.now(),
      },
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: {
        code: "SIGNING_FAILED",
        message: `Failed to sign brick: ${message}`,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify a brick's Ed25519 signature against its identity payload.
 *
 * @param brick - The brick identity fields that were signed.
 * @param signature - The BrickSignature to verify.
 * @returns Verification result with the determined trust tier.
 */
export function verifyBrickSignature(
  brick: BrickIdentityPayload,
  signature: BrickSignature,
): BrickVerificationResult {
  if (signature.algorithm !== "ed25519") {
    return {
      ok: false,
      reason: `Unsupported algorithm: ${signature.algorithm}`,
    };
  }

  const payload = computeSigningPayload(brick);
  const valid = verifyEd25519(payload, signature.publicKey, signature.signature);

  if (!valid) {
    return { ok: false, reason: "Signature verification failed" };
  }

  // Signature is valid — trust tier is "community" by default.
  // Callers can promote to "verified" by checking against registry trusted keys.
  return { ok: true, trustTier: "community" };
}

// ---------------------------------------------------------------------------
// Trust tier classification
// ---------------------------------------------------------------------------

/**
 * Determine the trust tier for a brick based on its signature and a set
 * of registry-trusted public keys.
 *
 * @param signature - The brick's signature (undefined = unsigned = "local").
 * @param brick - The brick identity fields.
 * @param trustedKeys - Set of base64-encoded SPKI DER public keys trusted by the registry.
 * @returns The resolved trust tier.
 */
export function classifyTrustTier(
  signature: BrickSignature | undefined,
  brick: BrickIdentityPayload,
  trustedKeys: ReadonlySet<string>,
): TrustTier {
  if (signature === undefined) {
    return "local";
  }

  const result = verifyBrickSignature(brick, signature);
  if (!result.ok) {
    return "local";
  }

  // If the signing key is in the trusted set, it's "verified"
  if (trustedKeys.has(signature.publicKey)) {
    return "verified";
  }

  return "community";
}
