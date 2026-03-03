/**
 * Nexus delegation hooks — syncs delegation grant/revoke events
 * to Nexus ReBAC tuples for external authorization.
 *
 * - onGrant: writes tuples (async-blocking, fail-closed — grant is rolled back on failure)
 * - onRevoke: deletes tuples (best-effort — non-fatal failures)
 */

import type { DelegationGrant, DelegationId } from "@koi/core";
import type { NexusPermissionBackend } from "./nexus-permission-backend.js";
import { mapGrantToTuples } from "./nexus-permission-backend.js";

// ---------------------------------------------------------------------------
// Hook types (matching DelegationManager callback signatures)
// ---------------------------------------------------------------------------

/** Called after a grant is stored. Throw to roll back the grant. */
export type OnGrantHook = (grant: DelegationGrant) => Promise<void>;

/** Called after a revocation completes. Best-effort — failures are non-fatal. */
export type OnRevokeHook = (grantId: DelegationId, cascade: boolean) => Promise<void>;

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Creates an onGrant hook that writes Zanzibar tuples to Nexus.
 * Async-blocking, fail-closed: if the write fails, the error propagates
 * and the DelegationManager rolls back the grant.
 */
export function createNexusOnGrant(backend: NexusPermissionBackend): OnGrantHook {
  return async (grant: DelegationGrant): Promise<void> => {
    const tuples = mapGrantToTuples(grant);
    if (tuples.length === 0) return;

    const result = await backend.batchWrite(
      tuples.map((tuple) => ({ tuple, operation: "write" as const })),
    );

    if (!result.ok) {
      throw new Error(`Nexus tuple write failed for grant ${grant.id}: ${result.error.message}`);
    }
  };
}

/**
 * Creates an onRevoke hook that deletes Zanzibar tuples from Nexus.
 * Best-effort: failures are silently absorbed (matching DelegationManager
 * onRevoke semantics — revocation is the safety operation).
 *
 * Note: requires the full grant to map to tuples. Since the grant may
 * already be removed from the store by the time onRevoke fires, this hook
 * accepts a grant lookup function.
 */
export function createNexusOnRevoke(
  backend: NexusPermissionBackend,
  getGrant: (grantId: DelegationId) => DelegationGrant | undefined,
): OnRevokeHook {
  return async (grantId: DelegationId, _cascade: boolean): Promise<void> => {
    const grant = getGrant(grantId);
    if (grant === undefined) return;

    const tuples = mapGrantToTuples(grant);
    if (tuples.length === 0) return;

    // Best-effort — ignore failures
    await backend
      .batchWrite(tuples.map((tuple) => ({ tuple, operation: "delete" as const })))
      .catch(() => {
        // Intentionally swallowed — revocation is the safety operation
      });
  };
}
