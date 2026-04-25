import type { AgentId, PersistentGrant, PersistentGrantCallback } from "@koi/core";
import type { ApprovalStore } from "./types.js";

export interface CreatePersistSinkOptions {
  /**
   * Resolve the actor scope recorded on the persisted approval. Defaults
   * to the live `grant.agentId`. Hosts that need a stable scope across
   * process restarts pass a function returning their manifest-derived id;
   * the same function MUST be passed to `wrapBackendWithPersistedAllowlist`
   * so writes and reads use the same key.
   */
  readonly resolveAgentId?: (grant: PersistentGrant) => AgentId;
}

/**
 * Adapter: convert PersistentGrant (session-scoped envelope from
 * gov-11) into a PersistedApproval (content-scoped record) and append
 * it to the durable store.
 *
 * `onApprovalPersist` is fire-and-forget at the governance-middleware
 * boundary — gov-core does NOT await this callback. Any rejected promise
 * surfaces as an unhandled rejection AFTER the user has already received
 * a session grant for the current call. We catch every store failure
 * (EACCES, ENOSPC, oversized row, malformed config) here so the runtime
 * never sees a rejected promise: the in-memory grant covers the active
 * call, and a console.warn surfaces the durability failure to the
 * operator. Hosts that need durable semantics must change gov-core to
 * await persistence before allowing.
 */
export function createPersistSink(
  store: ApprovalStore,
  options: CreatePersistSinkOptions = {},
): PersistentGrantCallback {
  const resolveAgentId = options.resolveAgentId ?? ((grant: PersistentGrant) => grant.agentId);
  return async (grant: PersistentGrant) => {
    try {
      await store.append({
        kind: grant.kind,
        agentId: resolveAgentId(grant),
        payload: grant.payload,
        grantKey: grant.grantKey,
        grantedAt: grant.grantedAt,
      });
    } catch (err) {
      console.warn(
        `[governance-approval-tiers] persistent approval append failed for grantKey=${grant.grantKey}; in-memory grant still applies for this session`,
        err,
      );
    }
  };
}
