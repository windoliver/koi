import type { DelegationScope, ScopeChecker } from "@koi/core";

/**
 * Match a toolId against a permission pattern. Supports:
 * - `*` — matches anything
 * - `prefix*` — matches any toolId starting with `prefix`
 * - exact literal otherwise
 *
 * Mirrors the matcher used by `@koi/middleware-permissions` so the two
 * layers agree on what `db:*` means.
 */
function matchesPattern(toolId: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return toolId.startsWith(pattern.slice(0, -1));
  return toolId === pattern;
}

function matchesAny(toolId: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesPattern(toolId, p));
}

/**
 * Default scope checker — applies deny-first glob matching against
 * `permissions.allow` / `permissions.deny` with `*` and `prefix*` support.
 *
 * Fails closed when:
 * - `scope.resources` is non-empty (this checker has no requested-resource
 *   projection from VerifyContext; resource-aware checks require a
 *   custom checker).
 * - `permissions.ask` matches the requested toolId (the default checker
 *   has no human-in-the-loop mechanism to grant the ask; production
 *   deployments needing ask must inject an interactive scope checker
 *   that can return true after explicit approval).
 *
 * Production deployments that issue resource-scoped or ask-bearing tokens
 * MUST inject a checker aware of those concepts.
 */
export function createGlobScopeChecker(): ScopeChecker {
  return {
    isAllowed(toolId: string, scope: DelegationScope): boolean {
      // Fail closed: resource-scoped tokens require a resource-aware checker.
      if (scope.resources && scope.resources.length > 0) return false;

      // Deny first — wildcard or prefix denies override allow.
      const deny = scope.permissions.deny ?? [];
      if (matchesAny(toolId, deny)) return false;

      // Ask without an interactive checker is fail-closed by default.
      const ask = scope.permissions.ask ?? [];
      if (matchesAny(toolId, ask)) return false;

      // Allow last.
      const allow = scope.permissions.allow ?? [];
      return matchesAny(toolId, allow);
    },
  };
}
