import type { ForgeCandidate } from "@koi/forge-types";
import type { PolicyAuditEntry, PolicyAuditLog } from "./audit.js";
import type { ForgePolicyConfig } from "./config.js";
import type { EvaluatePolicyOptions, PolicyEvaluation } from "./evaluate.js";
import { evaluatePolicy } from "./evaluate.js";

/**
 * Inputs for `evaluateAndRecord` — evaluator inputs plus the audit
 * log. Use this single-call API when the evaluating and recording
 * components might cross a worker/module/bundle boundary, since the
 * underlying authenticity brand is closure-private to one module
 * instance. `evaluateAndRecord` guarantees both calls happen inside
 * the same module so the evaluation never has to leave that scope
 * as a bare object that some peer instance might reject.
 */
export interface EvaluateAndRecordParams {
  readonly candidate: ForgeCandidate;
  readonly config: ForgePolicyConfig;
  readonly options?: EvaluatePolicyOptions;
  readonly evaluatedAt: number;
  readonly log: PolicyAuditLog;
}

/** Result of `evaluateAndRecord` — the evaluation plus the persisted
 *  audit entry. */
export interface EvaluateAndRecordResult {
  readonly evaluation: PolicyEvaluation;
  readonly entry: PolicyAuditEntry;
}

/**
 * Atomic evaluate-and-record: produces a `PolicyEvaluation` and
 * immediately persists the corresponding audit entry through the
 * supplied `PolicyAuditLog`. The evaluation object never crosses a
 * worker / module / bundle boundary as a bare object, so the
 * closure-private authenticity brand inside `recordEvaluation`
 * cannot reject a legitimate decision recorded through a peer
 * module instance. Recommended over manual `evaluatePolicy` →
 * `log.recordEvaluation` orchestration whenever the recorder lives
 * in a different component or thread than the evaluator.
 */
export function evaluateAndRecord(params: EvaluateAndRecordParams): EvaluateAndRecordResult {
  const evaluation = evaluatePolicy(params.candidate, params.config, params.options);
  const entry = params.log.recordEvaluation({
    evaluation,
    evaluatedAt: params.evaluatedAt,
  });
  return { evaluation, entry };
}
