/**
 * Grant revocation with eager cascading.
 *
 * When cascade=true, walks the grant index to find all descendants
 * (children, grandchildren, etc.) and revokes them all.
 */

import type { DelegationId, RevocationRegistry } from "@koi/core";
import type { GrantIndex } from "./registry.js";

/**
 * Revokes a delegation grant. If cascade=true, eagerly revokes all
 * descendants in the delegation chain.
 *
 * Returns the list of all revoked DelegationIds.
 *
 * Async because RevocationRegistry.revoke() / isRevoked() may be
 * backed by a network store.
 */
export async function revokeGrant(
  id: DelegationId,
  registry: RevocationRegistry,
  index: GrantIndex,
  cascade: boolean,
): Promise<readonly DelegationId[]> {
  const revoked: DelegationId[] = [];

  // Revoke the target
  await registry.revoke(id, false);
  revoked.push(id);

  // Cascade: BFS through children
  if (cascade) {
    const pending = [...index.childrenOf(id)];
    let i = 0;
    while (i < pending.length) {
      const childId = pending[i];
      i++;
      if (childId === undefined) continue;

      if (!(await registry.isRevoked(childId))) {
        await registry.revoke(childId, false);
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
