import type { DelegationScope, NamespaceMode } from "@koi/core";
import type { NexusDelegateScope, NexusNamespaceMode } from "./delegation-api.js";

export function mapNamespaceMode(mode: NamespaceMode | undefined): NexusNamespaceMode {
  switch (mode) {
    case "clean":
      return "CLEAN";
    case "shared":
      return "SHARED";
    case "copy":
    case undefined:
      return "COPY";
  }
}

export function mapScopeToNexus(scope: DelegationScope): NexusDelegateScope {
  return {
    allowed_operations: scope.permissions.allow ?? [],
    remove_grants: scope.permissions.deny ?? [],
    ...(scope.resources !== undefined ? { resource_patterns: scope.resources } : {}),
  };
}
