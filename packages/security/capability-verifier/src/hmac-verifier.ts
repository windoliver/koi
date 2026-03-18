/**
 * HMAC-SHA256 CapabilityVerifier implementation.
 *
 * Verifies capability tokens whose proof.kind === "hmac-sha256".
 * Performs all 6 DelegationDenyReason checks + session_invalid check:
 *
 * 1. proof_type_unsupported — token not hmac-sha256 proof
 * 2. invalid_signature — HMAC digest mismatch
 * 3. expired — expiresAt <= now
 * 4. session_invalid — scope.sessionId not in activeSessionIds
 * 5. chain_depth_exceeded — chainDepth > maxChainDepth
 * 6. scope_exceeded — toolId not allowed by scope permissions
 * 7. revoked — checked by caller (this verifier is stateless on revocation)
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CapabilityToken,
  CapabilityVerifier,
  CapabilityVerifyResult,
  ScopeChecker,
  VerifyContext,
} from "@koi/core";
import { canonicalize } from "@koi/crypto-utils";
import { checkScope } from "./scope-check.js";

const EXPECTED_HEX_LENGTH = 64;

/**
 * Verifies the HMAC-SHA256 proof of a capability token using timing-safe comparison.
 * Returns true only if the digest matches the expected digest for the given secret.
 */
function verifyHmacProof(token: CapabilityToken, secret: string): boolean {
  if (token.proof.kind !== "hmac-sha256") return false;

  const digest = token.proof.digest;
  if (digest.length !== EXPECTED_HEX_LENGTH) return false;

  const { proof: _proof, ...unsigned } = token;
  const canonical = canonicalize(unsigned);
  const expected = createHmac("sha256", secret).update(canonical).digest("hex");

  try {
    return timingSafeEqual(new Uint8Array(Buffer.from(expected, "hex")), new Uint8Array(Buffer.from(digest, "hex")));
  } catch {
    return false;
  }
}

/**
 * Creates a CapabilityVerifier for HMAC-SHA256 proofs.
 *
 * @param secret - The HMAC secret. Must be kept confidential.
 * @param scopeChecker - Optional pluggable scope checker. When provided,
 *   scope checking is delegated to it (enabling resource pattern matching).
 *   Falls back to internal isToolAllowed when absent.
 */
export function createHmacVerifier(
  secret: string,
  scopeChecker?: ScopeChecker,
): CapabilityVerifier {
  return {
    verify(
      token: CapabilityToken,
      context: VerifyContext,
    ): CapabilityVerifyResult | Promise<CapabilityVerifyResult> {
      // 1. Check proof type
      if (token.proof.kind !== "hmac-sha256") {
        return { ok: false, reason: "proof_type_unsupported" };
      }

      // 2. Verify HMAC digest (do this before expiry to fail fast on tampered tokens)
      if (!verifyHmacProof(token, secret)) {
        return { ok: false, reason: "invalid_signature" };
      }

      // 3. Check expiry (boundary: expiresAt === now is expired)
      if (token.expiresAt <= context.now) {
        return { ok: false, reason: "expired" };
      }

      // 4. Check session revocation
      if (!context.activeSessionIds.has(token.scope.sessionId)) {
        return { ok: false, reason: "session_invalid" };
      }

      // 5. Check chain depth
      if (token.chainDepth > token.maxChainDepth) {
        return { ok: false, reason: "chain_depth_exceeded" };
      }

      // 6. Check scope — delegate to scopeChecker when provided, else built-in
      return checkScope(context.toolId, token, scopeChecker);
    },
  };
}
