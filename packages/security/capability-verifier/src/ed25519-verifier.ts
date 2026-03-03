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
  VerifyContext,
} from "@koi/core";
import { verifyEd25519 } from "@koi/crypto-utils";

/**
 * Recursively sorts object keys to produce deterministic JSON.
 * Must be consistent with how the signature was computed during token issuance.
 */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Canonical JSON over a token with the proof field excluded.
 * This is the payload that was signed during token issuance.
 */
function canonicalize(token: Omit<CapabilityToken, "proof">): string {
  return JSON.stringify(sortKeys(token));
}

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
 * Checks if a toolId is permitted by the token's scope.
 */
function isToolAllowed(toolId: string, token: CapabilityToken): boolean {
  const { permissions } = token.scope;
  const allowList = permissions.allow ?? [];
  const denyList = permissions.deny ?? [];

  const colonIndex = toolId.indexOf(":");
  const toolName = colonIndex >= 0 ? toolId.slice(0, colonIndex) : toolId;

  if (denyList.includes(toolName) || denyList.includes(toolId)) {
    return false;
  }

  return allowList.includes(toolName) || allowList.includes("*");
}

/**
 * Creates a CapabilityVerifier for Ed25519-proof tokens.
 *
 * The public key is embedded in the token proof itself, so no external
 * key material is required for verification. The issuer's public key
 * is bound to the token at issuance time.
 */
export function createEd25519Verifier(): CapabilityVerifier {
  return {
    verify(token: CapabilityToken, context: VerifyContext): CapabilityVerifyResult {
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

      // 6. Check scope
      if (!isToolAllowed(context.toolId, token)) {
        return { ok: false, reason: "scope_exceeded" };
      }

      return { ok: true, token };
    },
  };
}
