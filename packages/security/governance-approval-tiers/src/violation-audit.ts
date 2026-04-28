import type { AgentId, PersistentGrant, PersistentGrantCallback } from "@koi/core";
import type { GovernanceVerdict, PolicyRequest, Violation } from "@koi/core/governance-backend";
import type { ApprovalStore } from "./types.js";

export interface ViolationAuditConfig {
  /**
   * Store the audit adapter writes the persisted approval to. The
   * adapter calls `store.append` directly (NOT through `createPersistSink`),
   * so it can distinguish a confirmed durable write from a swallowed
   * failure. The audit verdict is emitted only after `append` resolves —
   * never on failure — so the audit trail can be trusted as evidence
   * that approvals.json contains a matching row.
   */
  readonly store: ApprovalStore;
  readonly onViolation: (verdict: GovernanceVerdict, request: PolicyRequest) => void;
  /**
   * Resolve the agentId stamped onto the persisted record AND the
   * synthetic audit request. Defaults to `grant.agentId`. Hosts that
   * pin a stable scope across restarts (e.g. CLI uses manifest hostId)
   * pass a function returning that stable id; both writes and reads use
   * the same key.
   */
  readonly resolveAgentId?: (grant: PersistentGrant) => AgentId;
}

/**
 * Wrap an ApprovalStore so that every appended grant also emits a
 * synthetic info-severity Violation through the host's existing
 * onViolation channel. gov-2 audit sinks (ndjson, sqlite) pick it up
 * automatically — no direct coupling to the audit layer.
 *
 * `onApprovalPersist` is fire-and-forget at the governance-middleware
 * boundary. The adapter therefore:
 *   1. Builds the PersistedApproval and calls `store.append` directly.
 *   2. If append rejects, console.warn and RETURN — no audit row, no
 *      rejected promise. The user already received an in-memory grant
 *      for the live call; durability failed but the session is unaffected.
 *   3. If append resolves, emit the synthetic `approval.persisted`
 *      verdict via `onViolation`. The audit row is therefore evidence
 *      that approvals.json contains the grant.
 *
 * A buggy onViolation subscriber that throws is also caught so it cannot
 * crash the fire-and-forget callback.
 */
export function createViolationAuditAdapter(config: ViolationAuditConfig): PersistentGrantCallback {
  const resolveAgentId = config.resolveAgentId ?? ((grant: PersistentGrant) => grant.agentId);
  return async (grant: PersistentGrant) => {
    const scope = resolveAgentId(grant);
    let stored: Awaited<ReturnType<typeof config.store.append>>;
    try {
      stored = await config.store.append({
        kind: grant.kind,
        agentId: scope,
        payload: grant.payload,
        grantKey: grant.grantKey,
        grantedAt: grant.grantedAt,
      });
    } catch (err) {
      console.warn(
        `[governance-approval-tiers] persistent approval append failed for grantKey=${grant.grantKey}; in-memory grant still applies for this session`,
        err,
      );
      return;
    }

    // Codex round-3 finding: emit the audit with the CANONICAL stored
    // grantKey (post-alias canonicalisation), not the incoming
    // pre-alias one. When the store rewrote the payload, `aliasOf`
    // carries the original key for migration forensics.
    const audit: Violation = {
      rule: "approval.persisted",
      severity: "info",
      message: "Persistent approval recorded",
      context: {
        grantKey: stored.grantKey,
        grantedAt: stored.grantedAt,
        ...(stored.aliasOf !== undefined ? { aliasOf: stored.aliasOf } : {}),
      },
    };
    const verdict: GovernanceVerdict = { ok: true, diagnostics: [audit] };
    const request: PolicyRequest = {
      kind: stored.kind,
      agentId: stored.agentId,
      payload: grant.payload,
      timestamp: stored.grantedAt,
    };
    try {
      config.onViolation(verdict, request);
    } catch (err) {
      console.warn(
        `[governance-approval-tiers] audit adapter onViolation failed for grantKey=${grant.grantKey}`,
        err,
      );
    }
  };
}
