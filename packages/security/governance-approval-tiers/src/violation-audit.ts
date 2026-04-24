import type { PersistentGrant, PersistentGrantCallback } from "@koi/core";
import type { GovernanceVerdict, PolicyRequest, Violation } from "@koi/core/governance-backend";

export interface ViolationAuditConfig {
  readonly sink: PersistentGrantCallback;
  readonly onViolation: (verdict: GovernanceVerdict, request: PolicyRequest) => void;
}

/**
 * Wrap a PersistentGrantCallback so that every appended grant also
 * emits a synthetic info-severity Violation through the host's
 * existing onViolation channel. gov-2 audit sinks (ndjson, sqlite)
 * pick it up automatically — no direct coupling to the audit layer.
 */
export function createViolationAuditAdapter(config: ViolationAuditConfig): PersistentGrantCallback {
  return async (grant: PersistentGrant) => {
    await config.sink(grant);

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
      agentId: grant.agentId,
      payload: grant.payload,
      timestamp: grant.grantedAt,
    };
    config.onViolation(verdict, request);
  };
}
