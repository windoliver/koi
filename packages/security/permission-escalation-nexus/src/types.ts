import type { AgentId, EscalationDecision, EscalationRequest } from "@koi/core";

export const PERMISSION_ESCALATION_REQUEST_TYPE = "permission_escalation_request";
export const PERMISSION_ESCALATION_DECISION_TYPE = "permission_escalation_decision";

export interface PermissionEscalationRequestRecord {
  readonly kind: "permission_escalation_request";
  readonly request: EscalationRequest;
  readonly workerAgentId: AgentId;
  readonly coordinatorAgentId: AgentId;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface PermissionEscalationDecisionRecord {
  readonly requestId: string;
  readonly workerAgentId: AgentId;
  readonly coordinatorAgentId: AgentId;
  readonly decision: EscalationDecision;
  readonly resolvedAt: number;
  /**
   * Canonical fingerprint of the EscalationRequest the coordinator approved.
   * Workers replay a persisted decision only when the current request produces
   * the same fingerprint — prevents requestId reuse with mutated purpose/grants
   * from inheriting a stale approval.
   */
  readonly requestFingerprint: string;
}

/**
 * Computes a canonical fingerprint over the security-relevant fields of an
 * EscalationRequest. Stable across object key order and grant ordering so the
 * coordinator and worker derive the same value.
 */
export function computeEscalationRequestFingerprint(req: EscalationRequest): string {
  const sortedGrants = [...req.requestedGrants].sort();
  const canonical = {
    requestId: req.requestId,
    agentId: req.agentId,
    requestedGrants: sortedGrants,
    purposeStatement: req.purposeStatement,
    expiresAt: req.expiresAt,
    context: req.context ?? null,
  };
  return JSON.stringify(canonical);
}

export type PermissionEscalationRecord =
  | PermissionEscalationRequestRecord
  | PermissionEscalationDecisionRecord;
