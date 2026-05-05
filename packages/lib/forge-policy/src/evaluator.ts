import type { ForgeCandidate } from "@koi/forge-types";
import type { PolicyAuditEntry, PolicyAuditLog, PolicyAuditLogOptions } from "./audit.js";
import { createPolicyAuditLog } from "./audit.js";
import type { ForgePolicyConfig } from "./config.js";
import type { EvaluatePolicyOptions, PolicyEvaluation } from "./evaluate.js";
import { evaluatePolicy } from "./evaluate.js";

/**
 * Bundle of evaluator + audit log + atomic combinator returned by
 * `createPolicyEvaluator`. Both `log` and `evaluateAndRecord` are
 * guaranteed to reference the same module instance, so the
 * authenticity brand on a `PolicyEvaluation` produced here will
 * always be recognized by `log.recordEvaluation`.
 */
export interface ForgePolicyEvaluator {
  /** Bound atomic evaluator: produces an evaluation and persists its
   *  audit entry against the bundled `log`. Cannot be called with a
   *  foreign log — the log is closed over at construction. */
  readonly evaluateAndRecord: (params: EvaluateAndRecordBoundParams) => EvaluateAndRecordResult;
  /** The same-instance audit log. Exposed for read-only inspection
   *  (`entries`, `size`, `snapshot`). Direct `recordEvaluation` writes
   *  remain available but `evaluateAndRecord` is the recommended path. */
  readonly log: PolicyAuditLog;
}

/** Inputs for the bound `evaluateAndRecord` — the `log` is implicit. */
export interface EvaluateAndRecordBoundParams {
  readonly candidate: ForgeCandidate;
  readonly config: ForgePolicyConfig;
  readonly options?: EvaluatePolicyOptions;
  readonly evaluatedAt: number;
}

/** Result of the bound `evaluateAndRecord`. */
export interface EvaluateAndRecordResult {
  readonly evaluation: PolicyEvaluation;
  readonly entry: PolicyAuditEntry;
}

/**
 * Same-instance-by-construction factory. Returns an evaluator + audit
 * log pair where the authenticity brand is shared by definition.
 *
 * Use this in any deployment where the package might be loaded more
 * than once in a process (multiple bundles, separate Worker threads,
 * duplicated module copies). Splitting `evaluatePolicy` and
 * `createPolicyAuditLog` calls across separate instances is unsafe —
 * the brand is closure-private and `recordEvaluation` will reject
 * evaluations from a peer instance.
 *
 * The unbundled `evaluatePolicy`, `createPolicyAuditLog`, and
 * `evaluateAndRecord(params)` (with caller-supplied log) entry points
 * remain available for callers that statically know they live inside
 * a single module instance, but `createPolicyEvaluator` is the
 * recommended path.
 */
export function createPolicyEvaluator(
  auditOptions: PolicyAuditLogOptions = { failClosedOnOverflowSinkError: false },
): ForgePolicyEvaluator {
  const log = createPolicyAuditLog(auditOptions);
  function evaluateAndRecord(params: EvaluateAndRecordBoundParams): EvaluateAndRecordResult {
    const evaluation = evaluatePolicy(params.candidate, params.config, params.options);
    const entry = log.recordEvaluation({
      evaluation,
      evaluatedAt: params.evaluatedAt,
    });
    return { evaluation, entry };
  }
  return { evaluateAndRecord, log };
}
