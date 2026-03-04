/**
 * Ed25519 CapabilityVerifier implementation.
 *
 * Verifies capability tokens whose proof.kind === "ed25519".
 * Ed25519 provides cryptographic unforgeability for agent-to-agent
 * delegation chains without a shared secret.
 *
 * Verification uses the public key embedded in the proof.
 * Delegates Ed25519 verify to @koi/crypto-utils (fixes #508 DRY violation).
 *
 * Performs all checks in the same order as HmacVerifier:
 * 1. proof_type_unsupported
 * 2. invalid_signature (Ed25519 signature verification)
 * 3. expired
 * 4. session_invalid
 * 5. chain_depth_exceeded
 * 6. scope_exceeded
 */

import type {
  CapabilityToken,
  CapabilityVerifier,
  CapabilityVerifyResult,
  ScopeChecker,
  VerifyContext,
} from "@koi/core";
import { canonicalize, verifyEd25519 } from "@koi/crypto-utils";
import { checkScope } from "./scope-check.js";

/**
 * Verifies an Ed25519 signature on a capability token.
 * Uses the publicKey embedded in token.proof to verify.
 *
 * The publicKey in the proof is expected to be base64-encoded SPKI DER.
 * The signature is expected to be base64-encoded.
 */
function verifyEd25519Proof(token: CapabilityToken): boolean {
  if (token.proof.kind !== "ed25519") return false;

  const { publicKey, signature } = token.proof;
  const { proof: _proof, ...unsigned } = token;
  const payload = canonicalize(unsigned);

  return verifyEd25519(payload, publicKey, signature);
}

/**
 * Creates a CapabilityVerifier for Ed25519-proof tokens.
 *
 * The public key is embedded in the token proof itself, so no external
 * key material is required for verification. The issuer's public key
 * is bound to the token at issuance time.
 *
 * @param scopeChecker - Optional pluggable scope checker. When provided,
 *   scope checking is delegated to it. Falls back to internal isToolAllowed.
 */
export function createEd25519Verifier(scopeChecker?: ScopeChecker): CapabilityVerifier {
  return {
    verify(
      token: CapabilityToken,
      context: VerifyContext,
    ): CapabilityVerifyResult | Promise<CapabilityVerifyResult> {
      // 1. Check proof type
      if (token.proof.kind !== "ed25519") {
        return { ok: false, reason: "proof_type_unsupported" };
      }

      // 2. Verify Ed25519 signature
      if (!verifyEd25519Proof(token)) {
        return { ok: false, reason: "invalid_signature" };
      }

      // 3. Check expiry
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
