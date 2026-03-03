/**
 * HMAC-SHA256 signing backend — default pluggable signer for forge attestation.
 *
 * Uses node:crypto createHmac + timingSafeEqual. Implements the SigningBackend
 * contract from @koi/core.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { SigningBackend } from "@koi/core";

/**
 * Create an HMAC-SHA256 signing backend from a secret key.
 *
 * @param secretKey - The HMAC secret key (any length; node:crypto handles key normalization).
 * @returns A SigningBackend that signs/verifies using HMAC-SHA256.
 */
export function createHmacSigner(secretKey: Uint8Array): SigningBackend {
  const algorithm = "hmac-sha256";

  const sign = (data: Uint8Array): Uint8Array => {
    return new Uint8Array(createHmac("sha256", secretKey).update(data).digest());
  };

  const verify = (data: Uint8Array, signature: Uint8Array): boolean => {
    const expected = sign(data);
    if (expected.length !== signature.length) {
      return false;
    }
    return timingSafeEqual(expected, signature);
  };

  return { algorithm, sign, verify };
}
