/**
 * Outcome evaluator types — rubric-graded LLM-as-judge iteration loop (Layer 0).
 *
 * Provides type contracts for @koi/outcome-evaluator (L2). No logic, no imports.
 */

// ---------------------------------------------------------------------------
// Rubric definition
// ---------------------------------------------------------------------------

/** Structured rubric defining quality criteria for outcome evaluation. */
export interface OutcomeRubric {
  /** Human-readable description of what the agent should achieve. */
  readonly description: string;
  /** Criteria the agent's output will be evaluated against. */
  readonly criteria: readonly RubricCriterion[];
  /** Max evaluation iterations. Default: 3. Max: 20. */
  readonly maxIterations?: number | undefined;
}

/** A single evaluation criterion within a rubric. */
export interface RubricCriterion {
  /** Unique name used as key in evaluation results. */
  readonly name: string;
  /** What the grader should check for. */
  readonly description: string;
  /**
   * When false, failing this criterion does not block a "satisfied" result.
   * Advisory criteria appear in feedback but do not prevent completion.
   * Default: true.
   */
  readonly required?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Evaluation result
// ---------------------------------------------------------------------------

/**
 * Terminal outcome of a rubric evaluation cycle.
 *
 * - `satisfied`              — all required criteria passed
 * - `needs_revision`         — ≥1 required criterion failed; agent will be re-prompted
 * - `max_iterations_reached` — budget exhausted (or circuit breaker tripped)
 * - `grader_error`           — grader threw or returned unparseable response
 * - `interrupted`            — AbortSignal fired during evaluation
 */
export type OutcomeEvaluationResult =
  | "satisfied"
  | "needs_revision"
  | "max_iterations_reached"
  | "grader_error"
  | "interrupted";

/** Full evaluation record for one iteration of the rubric loop. */
export interface OutcomeEvaluation {
  readonly result: OutcomeEvaluationResult;
  /** 1-based iteration index (1 = first evaluation attempt). */
  readonly iteration: number;
  /** Per-criterion pass/fail results. */
  readonly criteria: readonly CriterionResult[];
  /** Grader's free-form explanation. Empty string on grader_error or interrupted. */
  readonly explanation: string;
}

/** Pass/fail result for a single rubric criterion. */
export interface CriterionResult {
  /** Must match a `RubricCriterion.name` from the rubric. */
  readonly name: string;
  readonly passed: boolean;
  /** What's missing or incorrect. Present only when `passed === false`. */
  readonly gap?: string | undefined;
}
