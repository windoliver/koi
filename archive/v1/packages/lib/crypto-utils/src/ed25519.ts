/**
 * Ed25519 cryptographic primitives — pure functions using node:crypto.
 *
 * Uses node:crypto which Bun supports natively and has correct TypeScript
 * types for Ed25519 operations. Key material is stored as base64-encoded
 * DER (SPKI for public keys, PKCS8 for private keys) to enable serialization
 * and cross-package sharing.
 *
 * All functions are side-effect-free. No state is held.
 */

import { generateKeyPairSync, sign, verify } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A generated Ed25519 key pair with DER-encoded keys as base64 strings. */
export interface Ed25519KeyPair {
  /** Base64-encoded SPKI DER public key. */
  readonly publicKeyDer: string;
  /** Base64-encoded PKCS8 DER private key. */
  readonly privateKeyDer: string;
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/**
 * Generates a fresh Ed25519 key pair.
 * Public key is SPKI DER, private key is PKCS8 DER, both base64-encoded.
 */
export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  return {
    publicKeyDer: publicKey.toString("base64"),
    privateKeyDer: privateKey.toString("base64"),
  };
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

/**
 * Signs a UTF-8 payload with an Ed25519 private key.
 *
 * @param payload - The string to sign (will be UTF-8 encoded).
 * @param privateKeyDer - Base64-encoded PKCS8 DER private key.
 * @returns Base64-encoded Ed25519 signature.
 */
export function signEd25519(payload: string, privateKeyDer: string): string {
  const privateKey = {
    key: Buffer.from(privateKeyDer, "base64"),
    format: "der" as const,
    type: "pkcs8" as const,
  };
  const signature = sign(null, new Uint8Array(Buffer.from(payload, "utf-8")), privateKey);
  return signature.toString("base64");
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verifies an Ed25519 signature against a UTF-8 payload.
 *
 * @param payload - The original string that was signed.
 * @param publicKeyDer - Base64-encoded SPKI DER public key.
 * @param signature - Base64-encoded signature produced by signEd25519.
 * @returns true if the signature is valid, false otherwise.
 */
export function verifyEd25519(payload: string, publicKeyDer: string, signature: string): boolean {
  try {
    const publicKey = {
      key: Buffer.from(publicKeyDer, "base64"),
      format: "der" as const,
      type: "spki" as const,
    };
    return verify(
      null,
      new Uint8Array(Buffer.from(payload, "utf-8")),
      publicKey,
      new Uint8Array(Buffer.from(signature, "base64")),
    );
  } catch {
    // Malformed key material or signature — treat as invalid
    return false;
  }
}
