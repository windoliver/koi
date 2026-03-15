/**
 * computeChildDelegationScope — intersects parent delegation scope with child
 * manifest permissions to produce an attenuated scope for auto-delegation.
 *
 * Uses L0 canonical scope operations (intersectPermissions, unionDenyLists)
 * to stay DRY with other delegation code paths.
 */

import type { DelegationScope, PermissionConfig } from "@koi/core";
import { intersectPermissions, unionDenyLists } from "@koi/core";

/**
 * Compute the delegation scope for a child agent by intersecting
 * the parent's scope with the child's manifest permissions.
 */
export function computeChildDelegationScope(
  parentScope: DelegationScope,
  childPermissions: PermissionConfig,
): DelegationScope {
  const allow = intersectPermissions(parentScope.permissions, childPermissions);
  const deny = unionDenyLists(parentScope.permissions, childPermissions);

  return {
    permissions: {
      ...(allow.length > 0 ? { allow } : {}),
      ...(deny.length > 0 ? { deny } : {}),
    },
    // Child inherits parent's resources — cannot expand
    ...(parentScope.resources !== undefined ? { resources: parentScope.resources } : {}),
  };
}
