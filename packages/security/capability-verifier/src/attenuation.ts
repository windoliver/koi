/**
 * Scope attenuation checking.
 *
 * Verifies that a child capability scope is a monotonic attenuation of its
 * parent: child permissions must be a strict subset of parent permissions.
 *
 * Uses Set<string> for O(N) subset check per the implementation plan (Issue 16).
 */

import type { PermissionConfig } from "@koi/core";

/**
 * Checks that child permissions are a strict subset of parent permissions.
 *
 * Rules:
 * - If parent.allow contains "*", any child allow list is valid
 * - Otherwise, every permission in child.allow must appear in parent.allow
 * - Every deny in parent.deny must appear in child.deny (deny only grows)
 *
 * @returns true if child is a valid attenuation of parent; false otherwise.
 */
export function isAttenuated(child: PermissionConfig, parent: PermissionConfig): boolean {
  const parentAllow = new Set(parent.allow ?? []);
  const childAllow = child.allow ?? [];

  // Wildcard in parent allows any child allow list
  if (!parentAllow.has("*")) {
    for (const perm of childAllow) {
      if (!parentAllow.has(perm)) {
        return false;
      }
    }
  }

  // Every parent deny must exist in child deny (deny only grows)
  const parentDeny = parent.deny ?? [];
  const childDeny = new Set(child.deny ?? []);

  for (const perm of parentDeny) {
    if (!childDeny.has(perm)) {
      return false;
    }
  }

  return true;
}
