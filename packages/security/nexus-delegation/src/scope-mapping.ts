import type { DelegationScope, NamespaceMode } from "@koi/core";
import type { NexusNamespaceMode } from "./delegation-api.js";

/**
 * Map Koi `NamespaceMode` to wire-format Nexus namespace_mode.
 *
 * Real Nexus v2 uses lowercase string literals.
 */
export function mapNamespaceMode(mode: NamespaceMode | undefined): NexusNamespaceMode {
  switch (mode) {
    case "clean":
      return "clean";
    case "shared":
      return "shared";
    case "copy":
    case undefined:
      return "copy";
  }
}

/**
 * Mapped grant adjustments derived from a Koi `DelegationScope`. These three
 * fields live at the top level of the wire-format `DelegateRequest`.
 *
 * - `add_grants`: paths/operations explicitly allowed (clean mode subset)
 * - `remove_grants`: paths/operations explicitly denied (copy mode exclusions)
 * - `readonly_paths`: paths downgraded to read-only (copy mode)
 */
export interface NexusScopeAdjustments {
  readonly add_grants: readonly string[];
  readonly remove_grants: readonly string[];
  readonly readonly_paths: readonly string[];
}

/**
 * Translate a Koi `DelegationScope` into Nexus v2 grant adjustments.
 *
 * - `permissions.allow` → `add_grants`
 * - `permissions.deny`  → `remove_grants`
 * - `readonly`          → `readonly_paths` (when present in scope.permissions)
 *
 * `resources` (glob patterns) are intentionally not mapped here — Nexus
 * carries them via the optional `scope` (DelegationScopeModel) object on the
 * request, not these flat fields. Callers that need them should set
 * `request.scope.resource_patterns` directly.
 */
export function mapScopeToNexus(scope: DelegationScope): NexusScopeAdjustments {
  return {
    add_grants: scope.permissions.allow ?? [],
    remove_grants: scope.permissions.deny ?? [],
    readonly_paths: [],
  };
}
