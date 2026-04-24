import type { PersistentGrant, PersistentGrantCallback } from "@koi/core";
import type { ApprovalStore } from "./types.js";

/**
 * Adapter: convert PersistentGrant (session-scoped envelope from
 * gov-11) into a PersistedApproval (content-scoped record) and append
 * it to the durable store. agentId/sessionId are stripped because the
 * grant applies to the canonical (kind, payload), not to the actor.
 */
export function createPersistSink(store: ApprovalStore): PersistentGrantCallback {
  return async (grant: PersistentGrant) => {
    await store.append({
      kind: grant.kind,
      payload: grant.payload,
      grantKey: grant.grantKey,
      grantedAt: grant.grantedAt,
    });
  };
}
