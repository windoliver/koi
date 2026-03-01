/**
 * Domain types for @koi/exec-approvals.
 */

import type { JsonObject } from "@koi/core/common";
import type { RiskAnalysis } from "@koi/core/security-analyzer";

/**
 * The 5 decisions a user can make when prompted for approval.
 *
 * - allow_once: allow this single invocation only
 * - allow_session: allow for the remainder of this session
 * - allow_always: allow permanently (pattern written to store)
 * - deny_once: deny this single invocation
 * - deny_always: deny permanently (pattern written to store)
 */
export type ProgressiveDecision =
  | { readonly kind: "allow_once" }
  | { readonly kind: "allow_session"; readonly pattern: string }
  | { readonly kind: "allow_always"; readonly pattern: string }
  | { readonly kind: "deny_once"; readonly reason: string }
  | { readonly kind: "deny_always"; readonly pattern: string; readonly reason: string };

/**
 * The shape persisted in the backing store.
 */
export interface PersistedRules {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

/**
 * Pluggable backing store for "always" decisions.
 * Use createInMemoryRulesStore() for testing/development.
 */
export interface ExecRulesStore {
  readonly load: () => Promise<PersistedRules>;
  readonly save: (rules: PersistedRules) => Promise<void>;
}

/**
 * The request passed to onAsk when an ask rule fires.
 *
 * TODO: ExecApprovalRequest and @koi/core ApprovalRequest serve similar purposes.
 * Consolidation tracked in issue #75 follow-up.
 */
export interface ExecApprovalRequest {
  readonly toolId: string;
  readonly input: JsonObject;
  /** Which ask pattern triggered this request. */
  readonly matchedPattern: string;
  /**
   * Risk analysis result from SecurityAnalyzer, if one is configured.
   * Populated by withRiskAnalysis HOF in @koi/security-analyzer.
   * Absent when no securityAnalyzer is configured in ExecApprovalsConfig.
   */
  readonly riskAnalysis?: RiskAnalysis;
}
