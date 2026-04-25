import type { DelegationScope, ScopeChecker } from "@koi/core";

export function createGlobScopeChecker(): ScopeChecker {
  return {
    isAllowed(toolId: string, scope: DelegationScope): boolean {
      const deny = scope.permissions.deny ?? [];
      if (deny.includes(toolId)) return false;

      const allow = scope.permissions.allow ?? [];
      if (allow.includes("*")) return true;
      return allow.includes(toolId);
    },
  };
}
