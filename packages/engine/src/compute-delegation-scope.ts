/**
 * computeChildDelegationScope — intersects parent delegation scope with child
 * manifest permissions to produce an attenuated scope for auto-delegation.
 *
 * Attenuation rules:
 * - allow = intersection of parent and child allow (parent "*" → use child's allow)
 * - deny  = union of parent and child deny (deny only grows)
 * - resources = parent's resources (child cannot expand)
 */

import type { DelegationScope, PermissionConfig } from "@koi/core";

/**
 * Compute the delegation scope for a child agent by intersecting
 * the parent's scope with the child's manifest permissions.
 */
export function computeChildDelegationScope(
  parentScope: DelegationScope,
  childPermissions: PermissionConfig,
): DelegationScope {
  const parentAllow = parentScope.permissions.allow ?? [];
  const parentDeny = parentScope.permissions.deny ?? [];
  const childAllow = childPermissions.allow ?? [];
  const childDeny = childPermissions.deny ?? [];

  // allow = intersection: if parent has wildcard, use child's allow list;
  // otherwise, keep only what both parent and child allow
  const isParentWildcard = parentAllow.includes("*");
  const allow: readonly string[] = isParentWildcard
    ? childAllow
    : parentAllow.filter((tool) => childAllow.includes(tool) || childAllow.includes("*"));

  // deny = union: child inherits all parent deny rules + adds its own
  const denySet = new Set([...parentDeny, ...childDeny]);
  const deny: readonly string[] = [...denySet];

  return {
    permissions: {
      ...(allow.length > 0 ? { allow } : {}),
      ...(deny.length > 0 ? { deny } : {}),
    },
    // Child inherits parent's resources — cannot expand
    ...(parentScope.resources !== undefined ? { resources: parentScope.resources } : {}),
  };
}
