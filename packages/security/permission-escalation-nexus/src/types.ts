import type { AgentId, PermissionDecision, PermissionRequest } from "@koi/core";

export interface PermissionEscalationRequestRecord {
  readonly kind: "permission_escalation_request";
  readonly request: PermissionRequest;
  readonly workerAgentId: AgentId;
  readonly coordinatorAgentId: AgentId;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface PermissionEscalationDecisionRecord {
  readonly kind: "permission_escalation_decision";
  readonly requestId: string;
  readonly workerAgentId: AgentId;
  readonly coordinatorAgentId: AgentId;
  readonly decision: PermissionDecision;
  readonly resolvedAt: number;
}
