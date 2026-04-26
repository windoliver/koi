import type { PermissionConfig } from "@koi/core";
import { isPermissionSubset } from "@koi/core";

/**
 * Strict permission attenuation that extends L0's `isPermissionSubset` with
 * `ask` preservation.
 *
 * L0's helper enforces:
 * - allow: child ⊆ parent (or parent contains "*")
 * - deny:  parent ⊆ child (deny only grows)
 *
 * It does NOT enforce ask preservation, which lets a child drop human-
 * approval requirements that the parent declared. Example: parent
 * `{allow:["*"], ask:["bash"]}` delegating child `{allow:["*"]}` would
 * silently strip the bash-ask requirement, turning gated tools into
 * unattended grants.
 *
 * Rule added here: every entry in parent.ask must remain in child.ask
 * OR be moved into child.deny (deny is strictly more restrictive, so
 * promoting ask→deny is acceptable attenuation).
 */
export function isPermissionSubsetWithAsk(
  child: PermissionConfig,
  parent: PermissionConfig,
): boolean {
  if (!isPermissionSubset(child, parent)) return false;
  const parentAsk = parent.ask ?? [];
  if (parentAsk.length === 0) return true;
  const childAsk = new Set(child.ask ?? []);
  const childDeny = new Set(child.deny ?? []);
  for (const entry of parentAsk) {
    // Either preserved as ask, or strengthened to deny.
    if (!childAsk.has(entry) && !childDeny.has(entry)) return false;
  }
  return true;
}
