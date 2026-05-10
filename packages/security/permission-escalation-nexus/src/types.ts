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
}

export type PermissionEscalationRecord =
  | PermissionEscalationRequestRecord
  | PermissionEscalationDecisionRecord;
