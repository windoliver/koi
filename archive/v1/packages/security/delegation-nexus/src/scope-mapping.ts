/**
 * Scope mapping — converts Koi DelegationScope to Nexus DelegateRequest format.
 *
 * Pure function — no I/O, no side effects. Testable in isolation.
 */

import type { DelegationScope, NamespaceMode } from "@koi/core";
import type { NexusDelegateScope, NexusNamespaceMode } from "@koi/nexus-client";

/**
 * Map a Koi NamespaceMode to the Nexus wire format.
 * Defaults to "COPY" when no mode is specified.
 */
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

/**
 * Map a Koi DelegationScope to the Nexus scope wire format.
 *
 * Mapping rules:
 * - permissions.allow -> allowed_operations (wildcard "*" preserved)
 * - permissions.deny -> remove_grants
 * - resources -> resource_patterns (glob syntax preserved)
 */
export function mapScopeToNexus(scope: DelegationScope): NexusDelegateScope {
  return {
    allowed_operations: scope.permissions.allow ?? [],
    remove_grants: scope.permissions.deny ?? [],
    ...(scope.resources !== undefined ? { resource_patterns: scope.resources } : {}),
  };
}
