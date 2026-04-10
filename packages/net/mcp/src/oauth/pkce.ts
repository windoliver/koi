/**
 * PKCE (Proof Key for Code Exchange) utilities for OAuth 2.0.
 *
 * Generates code verifier and S256 code challenge per RFC 7636.
 */

import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PkceChallenge {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Generates a PKCE code verifier and S256 challenge.
 *
 * - Verifier: 43-byte random value, base64url-encoded (per RFC 7636 §4.1)
 * - Challenge: SHA-256 hash of verifier, base64url-encoded (per RFC 7636 §4.2)
 */
export function createPkceChallenge(): PkceChallenge {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}
