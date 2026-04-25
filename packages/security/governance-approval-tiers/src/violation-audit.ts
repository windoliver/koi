import type { AgentId, PersistentGrant, PersistentGrantCallback } from "@koi/core";
import type { GovernanceVerdict, PolicyRequest, Violation } from "@koi/core/governance-backend";

export interface ViolationAuditConfig {
  readonly sink: PersistentGrantCallback;
  readonly onViolation: (verdict: GovernanceVerdict, request: PolicyRequest) => void;
  /**
   * Resolve the agentId stamped onto the synthetic audit request.
   * Defaults to `grant.agentId`. Hosts that pin a stable scope on the
   * persisted record (e.g. CLI uses manifest hostId via `createPersistSink`'s
   * `resolveAgentId`) MUST pass the same resolver here so the audit row
   * agrees with the persisted approval.
   */
  readonly resolveAgentId?: (grant: PersistentGrant) => AgentId;
}

/**
 * Wrap a PersistentGrantCallback so that every appended grant also
 * emits a synthetic info-severity Violation through the host's
 * existing onViolation channel. gov-2 audit sinks (ndjson, sqlite)
 * pick it up automatically — no direct coupling to the audit layer.
 *
 * Both `sink` and `onViolation` are protected by an internal try/catch:
 * `onApprovalPersist` is fire-and-forget at the governance-middleware
 * boundary, so a rejected promise here would surface as an unhandled
 * rejection AFTER the user already received a session grant. Failures
 * are logged and absorbed; in-memory grants still cover the live call.
 */
export function createViolationAuditAdapter(config: ViolationAuditConfig): PersistentGrantCallback {
  const resolveAgentId = config.resolveAgentId ?? ((grant: PersistentGrant) => grant.agentId);
  return async (grant: PersistentGrant) => {
    try {
      await config.sink(grant);
    } catch (err) {
      console.warn(
        `[governance-approval-tiers] audit adapter sink failed for grantKey=${grant.grantKey}`,
        err,
      );
      return;
    }

    const audit: Violation = {
      rule: "approval.persisted",
      severity: "info",
      message: "Persistent approval recorded",
      context: {
        grantKey: grant.grantKey,
        grantedAt: grant.grantedAt,
      },
    };
    const verdict: GovernanceVerdict = { ok: true, diagnostics: [audit] };
    const request: PolicyRequest = {
      kind: grant.kind,
      agentId: resolveAgentId(grant),
      payload: grant.payload,
      timestamp: grant.grantedAt,
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
