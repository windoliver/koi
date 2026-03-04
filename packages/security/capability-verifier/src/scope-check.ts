/**
 * Shared scope-checking logic for capability verifiers.
 *
 * Provides a unified function that delegates to an optional ScopeChecker
 * when present, or falls back to built-in allow/deny list matching.
 */

import type { CapabilityToken, CapabilityVerifyResult, ScopeChecker } from "@koi/core";

/**
 * Checks if a toolId is permitted by the token's scope.
 *
 * Matching rules:
 * - "*" in allow list matches any tool
 * - Tool name is matched before ':' if resource path is present
 * - deny overrides allow
 */
export function isToolAllowed(toolId: string, token: CapabilityToken): boolean {
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

/**
 * Checks scope using the pluggable ScopeChecker when provided,
 * falling back to built-in isToolAllowed.
 *
 * Returns a CapabilityVerifyResult synchronously when possible,
 * or a Promise when the ScopeChecker is async.
 */
export function checkScope(
  toolId: string,
  token: CapabilityToken,
  scopeChecker: ScopeChecker | undefined,
): CapabilityVerifyResult | Promise<CapabilityVerifyResult> {
  if (scopeChecker !== undefined) {
    const allowed = scopeChecker.isAllowed(toolId, token.scope);
    if (typeof allowed === "boolean") {
      return allowed ? { ok: true, token } : { ok: false, reason: "scope_exceeded" };
    }
    return allowed.then(
      (ok): CapabilityVerifyResult =>
        ok ? { ok: true, token } : { ok: false, reason: "scope_exceeded" },
    );
  }

  if (!isToolAllowed(toolId, token)) {
    return { ok: false, reason: "scope_exceeded" };
  }

  return { ok: true, token };
}
