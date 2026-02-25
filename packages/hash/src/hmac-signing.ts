/**
 * HMAC-SHA256 signing backend — default pluggable signer for forge attestation.
 *
 * Uses Bun.CryptoHasher for HMAC computation. Implements the SigningBackend
 * contract from @koi/core.
 */

import type { SigningBackend } from "@koi/core";

/**
 * Create an HMAC-SHA256 signing backend from a secret key.
 *
 * @param secretKey - The HMAC secret key (any length; will be hashed if > 64 bytes).
 * @returns A SigningBackend that signs/verifies using HMAC-SHA256.
 */
export function createHmacSigner(secretKey: Uint8Array): SigningBackend {
  const algorithm = "hmac-sha256";

  function hmac(key: Uint8Array, data: Uint8Array): Uint8Array {
    const BLOCK_SIZE = 64;

    // If key is longer than block size, hash it first
    // let justified: key may be shortened by hashing
    let normalizedKey: Uint8Array;
    if (key.length > BLOCK_SIZE) {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(key);
      normalizedKey = new Uint8Array(hasher.digest());
    } else {
      normalizedKey = key;
    }

    // Pad key to block size
    const paddedKey = new Uint8Array(BLOCK_SIZE);
    paddedKey.set(normalizedKey);

    // Inner and outer pads
    const innerPad = new Uint8Array(BLOCK_SIZE);
    const outerPad = new Uint8Array(BLOCK_SIZE);
    for (let i = 0; i < BLOCK_SIZE; i++) {
      const keyByte = paddedKey[i] ?? 0;
      innerPad[i] = keyByte ^ 0x36;
      outerPad[i] = keyByte ^ 0x5c;
    }

    // Inner hash: H(innerPad || data)
    const innerHasher = new Bun.CryptoHasher("sha256");
    innerHasher.update(innerPad);
    innerHasher.update(data);
    const innerDigest = new Uint8Array(innerHasher.digest());

    // Outer hash: H(outerPad || innerHash)
    const outerHasher = new Bun.CryptoHasher("sha256");
    outerHasher.update(outerPad);
    outerHasher.update(innerDigest);
    return new Uint8Array(outerHasher.digest());
  }

  const sign = (data: Uint8Array): Uint8Array => {
    return hmac(secretKey, data);
  };

  const verify = (data: Uint8Array, signature: Uint8Array): boolean => {
    const expected = hmac(secretKey, data);
    if (expected.length !== signature.length) {
      return false;
    }
    // Constant-time comparison to prevent timing attacks
    // let justified: accumulator for bitwise OR comparison
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= (expected[i] ?? 0) ^ (signature[i] ?? 0);
    }
    return diff === 0;
  };

  return { algorithm, sign, verify };
}
