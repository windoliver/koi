/**
 * Grant verification — full verification on every tool call.
 *
 * Checks (in order):
 * 1. HMAC signature integrity
 * 2. Expiry
 * 3. Revocation
 * 4. Chain depth
 * 5. Scope match (tool + resource patterns)
 */

import type {
  DelegationGrant,
  DelegationScope,
  DelegationVerifyResult,
  RevocationRegistry,
  ScopeChecker,
} from "@koi/core";
import { verifySignature } from "./sign.js";

/** Default ScopeChecker backed by glob-style matching. */
export const defaultScopeChecker: ScopeChecker = {
  isAllowed: matchToolAgainstScope,
};

/**
 * Full verification of a delegation grant for a specific tool call.
 * Called on every tool invocation (decision #13).
 *
 * Accepts an optional ScopeChecker for pluggable permission engines.
 * Falls back to the built-in glob-style matcher when not provided.
 */
export function verifyGrant(
  grant: DelegationGrant,
  toolId: string,
  registry: RevocationRegistry,
  secret: string,
  now?: number,
  scopeChecker?: ScopeChecker,
): DelegationVerifyResult {
  const currentTime = now ?? Date.now();
  const checker = scopeChecker ?? defaultScopeChecker;

  // 1. Verify HMAC signature
  if (!verifySignature(grant, secret)) {
    return { ok: false, reason: "invalid_signature" };
  }

  // 2. Check expiry
  if (grant.expiresAt <= currentTime) {
    return { ok: false, reason: "expired" };
  }

  // 3. Check revocation
  if (registry.isRevoked(grant.id)) {
    return { ok: false, reason: "revoked" };
  }

  // 4. Check chain depth
  if (grant.chainDepth > grant.maxChainDepth) {
    return { ok: false, reason: "chain_depth_exceeded" };
  }

  // 5. Match scope (pluggable)
  if (!checker.isAllowed(toolId, grant.scope)) {
    return { ok: false, reason: "scope_exceeded" };
  }

  return { ok: true, grant };
}

// ---------------------------------------------------------------------------
// Scope matching
// ---------------------------------------------------------------------------

/**
 * Checks whether a tool invocation is allowed by the delegation scope.
 *
 * Matching rules:
 * - Tool name is extracted from toolId (before ':' if resource path present)
 * - "*" in allow list matches any tool name
 * - If deny list contains the tool name, it is denied (deny > allow)
 * - If resource patterns are defined, toolId must match at least one pattern
 */
export function matchToolAgainstScope(toolId: string, scope: DelegationScope): boolean {
  const allowList = scope.permissions.allow ?? [];
  const denyList = scope.permissions.deny ?? [];

  // Extract tool name (before ':' if present)
  const colonIndex = toolId.indexOf(":");
  const toolName = colonIndex >= 0 ? toolId.slice(0, colonIndex) : toolId;

  // Check deny first (deny overrides allow)
  if (denyList.includes(toolName) || denyList.includes(toolId)) {
    return false;
  }

  // Check allow — must match tool name or wildcard
  const allowed = allowList.includes(toolName) || allowList.includes("*");
  if (!allowed) {
    return false;
  }

  // If resource patterns are defined and toolId has a resource path, match patterns
  if (scope.resources !== undefined && scope.resources.length > 0 && colonIndex >= 0) {
    return scope.resources.some((pattern) => matchGlob(pattern, toolId));
  }

  return true;
}

/**
 * Simple glob-style pattern matching.
 * Supports `**` (match any path segments) and `*` (match within one segment).
 *
 * Compiled regexes are cached — same pattern string reuses the same RegExp
 * instance across calls (hot path: every tool call).
 */
const globCache = new Map<string, RegExp>();

function matchGlob(pattern: string, value: string): boolean {
  let regex = globCache.get(pattern);
  if (regex === undefined) {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex special chars
      .replace(/\*\*/g, "\0") // temp placeholder for **
      .replace(/\*/g, "[^/]*") // * matches non-slash
      .replace(/\0/g, ".*"); // ** matches anything
    regex = new RegExp(`^${regexStr}$`);
    globCache.set(pattern, regex);
  }
  return regex.test(value);
}
