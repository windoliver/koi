import type { DelegationScope, ScopeChecker } from "@koi/core";

/**
 * Default scope checker — matches a toolId against `permissions.allow` /
 * `permissions.deny` with `*` wildcard. Fails closed on resource-scoped
 * tokens: VerifyContext does not carry a requested resource, so this
 * checker cannot enforce `scope.resources`. Production deployments that
 * issue resource-scoped tokens MUST inject a resource-aware scope checker
 * that knows how to project the requested resource from request context.
 */
export function createGlobScopeChecker(): ScopeChecker {
  return {
    isAllowed(toolId: string, scope: DelegationScope): boolean {
      // Fail closed: resource-scoped tokens require a resource-aware checker.
      if (scope.resources && scope.resources.length > 0) return false;

      const deny = scope.permissions.deny ?? [];
      if (deny.includes(toolId)) return false;

      const allow = scope.permissions.allow ?? [];
      if (allow.includes("*")) return true;
      return allow.includes(toolId);
    },
  };
}
