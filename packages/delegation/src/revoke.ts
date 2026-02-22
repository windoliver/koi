/**
 * Grant revocation with eager cascading.
 *
 * When cascade=true, walks the grant index to find all descendants
 * (children, grandchildren, etc.) and revokes them all.
 */

import type { DelegationGrant, DelegationId, RevocationRegistry } from "@koi/core";
import type { GrantIndex } from "./registry.js";

/**
 * Revokes a delegation grant. If cascade=true, eagerly revokes all
 * descendants in the delegation chain.
 *
 * Returns the list of all revoked DelegationIds.
 */
export function revokeGrant(
  id: DelegationId,
  registry: RevocationRegistry,
  _grants: ReadonlyMap<DelegationId, DelegationGrant>,
  index: GrantIndex,
  cascade: boolean,
): readonly DelegationId[] {
  const revoked: DelegationId[] = [];

  // Revoke the target
  registry.revoke(id, false);
  revoked.push(id);

  // Cascade: BFS through children
  if (cascade) {
    // BFS through children (no mutation of external state)
    const pending = [...index.childrenOf(id)];
    let i = 0;
    while (i < pending.length) {
      const childId = pending[i];
      i++;
      if (childId === undefined) continue;

      if (!registry.isRevoked(childId)) {
        registry.revoke(childId, false);
        revoked.push(childId);
      }

      // Add grandchildren to queue
      const grandchildren = index.childrenOf(childId);
      for (const gc of grandchildren) {
        pending.push(gc);
      }
    }
  }

  return revoked;
}
