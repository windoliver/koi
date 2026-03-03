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
  VerifyContext,
} from "@koi/core";

const EXPECTED_HEX_LENGTH = 64;

/**
 * Recursively sorts object keys to produce deterministic JSON.
 * Must be consistent with how the HMAC was computed during token issuance.
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
 * Used to reproduce the HMAC input during verification.
 */
function canonicalize(token: Omit<CapabilityToken, "proof">): string {
  return JSON.stringify(sortKeys(token));
}

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
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(digest, "hex"));
  } catch {
    return false;
  }
}

/**
 * Creates a CapabilityVerifier for HMAC-SHA256 proofs.
 *
 * @param secret - The HMAC secret. Must be kept confidential.
 * @param allowedTools - Optional predicate for tool-based scope checking.
 *   When not provided, defaults to checking token.scope.permissions.allow.
 */
export function createHmacVerifier(secret: string): CapabilityVerifier {
  return {
    verify(token: CapabilityToken, context: VerifyContext): CapabilityVerifyResult {
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

      // 6. Check scope (tool must be in allow list, not in deny list)
      if (!isToolAllowed(context.toolId, token)) {
        return { ok: false, reason: "scope_exceeded" };
      }

      return { ok: true, token };
    },
  };
}

/**
 * Checks if a toolId is permitted by the token's scope.
 *
 * Matching rules:
 * - "*" in allow list matches any tool
 * - Tool name is matched before ':' if resource path is present
 * - deny overrides allow
 */
function isToolAllowed(toolId: string, token: CapabilityToken): boolean {
  const { permissions } = token.scope;
  const allowList = permissions.allow ?? [];
  const denyList = permissions.deny ?? [];

  // Extract tool name (before ':' if resource path present)
  const colonIndex = toolId.indexOf(":");
  const toolName = colonIndex >= 0 ? toolId.slice(0, colonIndex) : toolId;

  // Deny overrides allow
  if (denyList.includes(toolName) || denyList.includes(toolId)) {
    return false;
  }

  // Must be in allow list
  return allowList.includes(toolName) || allowList.includes("*");
}
