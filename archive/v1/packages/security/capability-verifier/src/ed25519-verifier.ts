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
 * Resolves an issuer's expected public key.
 * Implementations may be backed by an in-memory map, a database, or a remote service.
 */
export interface PublicKeyRegistry {
  /** Returns the expected base64-encoded SPKI DER public key for the given issuerId, or undefined if unknown. */
  readonly resolve: (issuerId: string) => string | undefined | Promise<string | undefined>;
}

/**
 * Creates a CapabilityVerifier for Ed25519-proof tokens.
 *
 * When a keyRegistry is provided, the verifier checks that the embedded
 * public key matches the registry's expected key for the token's issuerId.
 * This prevents self-signed token forgery where an attacker mints a token
 * with an arbitrary issuerId and their own key.
 *
 * @param scopeChecker - Optional pluggable scope checker.
 * @param keyRegistry - Optional registry to verify issuer key binding.
 */
export function createEd25519Verifier(
  scopeChecker?: ScopeChecker,
  keyRegistry?: PublicKeyRegistry,
): CapabilityVerifier {
  /** Run all checks after key binding has been verified. */
  function verifyAfterKeyCheck(
    token: CapabilityToken,
    context: VerifyContext,
  ): CapabilityVerifyResult | Promise<CapabilityVerifyResult> {
    // 2b. Verify Ed25519 signature
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
  }

  /** Validate embedded key against registry's expected key. */
  function checkKeyBinding(
    expectedKey: string | undefined,
    token: CapabilityToken,
  ): CapabilityVerifyResult | undefined {
    if (expectedKey === undefined) {
      return { ok: false, reason: "invalid_signature" };
    }
    if (token.proof.kind === "ed25519" && token.proof.publicKey !== expectedKey) {
      return { ok: false, reason: "invalid_signature" };
    }
    return undefined; // Key matches — proceed
  }

  return {
    verify(
      token: CapabilityToken,
      context: VerifyContext,
    ): CapabilityVerifyResult | Promise<CapabilityVerifyResult> {
      // 1. Check proof type
      if (token.proof.kind !== "ed25519") {
        return { ok: false, reason: "proof_type_unsupported" };
      }

      // 2a. Verify issuer key binding when registry is available
      if (keyRegistry !== undefined) {
        const resolved = keyRegistry.resolve(token.issuerId);
        if (resolved instanceof Promise) {
          return resolved.then((expectedKey) => {
            const bindingResult = checkKeyBinding(expectedKey, token);
            if (bindingResult !== undefined) return bindingResult;
            return verifyAfterKeyCheck(token, context);
          });
        }
        const bindingResult = checkKeyBinding(resolved, token);
        if (bindingResult !== undefined) return bindingResult;
      }

      return verifyAfterKeyCheck(token, context);
    },
  };
}
