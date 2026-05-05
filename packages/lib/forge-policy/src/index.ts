/**
 * @koi/forge-policy — sync deterministic policy evaluator + audit log for
 * forge candidates (L2). Issue #1349.
 *
 * Depends on @koi/core (L0) and @koi/forge-types (L0u) only.
 */

export type {
  PolicyAuditEntry,
  PolicyAuditLog,
  PolicyAuditLogOptions,
  RecordEvaluationParams,
} from "./audit.js";
export { createPolicyAuditLog } from "./audit.js";
export type { ForgePolicyConfig, PolicyOverride } from "./config.js";
export type { EvaluatePolicyOptions, PolicyEvaluation } from "./evaluate.js";
export { evaluatePolicy, MAX_ARRAY_LENGTH, STRUCTURAL_BUDGET_BYTES } from "./evaluate.js";
export type {
  EvaluateAndRecordParams,
  EvaluateAndRecordResult,
} from "./evaluate-and-record.js";
export { evaluateAndRecord } from "./evaluate-and-record.js";
export type {
  EvaluateAndRecordBoundParams,
  ForgePolicyEvaluator,
} from "./evaluator.js";
export { createPolicyEvaluator } from "./evaluator.js";
export { computeConfigFingerprint, POLICY_EVALUATOR_VERSION } from "./fingerprint.js";
