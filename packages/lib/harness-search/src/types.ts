/**
 * Types for @koi/harness-search.
 *
 * harness-search runs the bounded refinement loop over synthesized
 * variants. Single-candidate synthesis itself lives in @koi/harness-synth;
 * this package owns the outer search/refinement loop only.
 */

import type { ToolDescriptor } from "@koi/core";

// ---------------------------------------------------------------------------
// Search node — a single code variant evaluated during the search
// ---------------------------------------------------------------------------

/** A single synthesized variant with its evaluation result. */
export interface SearchNode {
  readonly id: string;
  readonly code: string;
  readonly descriptor: ToolDescriptor;
  /** Iteration index (0 = initial, 1+ = refinements). */
  readonly iteration: number;
  /** Success rate from evaluation (0..1). null if evaluation never produced a value. */
  readonly successRate: number | null;
  /** Number of evaluation samples backing `successRate`. */
  readonly evalSamples: number;
  /** Parent node id (null for root). */
  readonly parentId: string | null;
  /** Wall-clock timestamp from `clock()`. */
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Result of evaluating a variant. */
export interface EvalResult {
  readonly successRate: number;
  readonly sampleCount: number;
  readonly failures: readonly EvalFailure[];
}

/** A single evaluation failure — fed back into the refine callback. */
export interface EvalFailure {
  readonly toolName: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Callbacks (caller-injected; harness-search owns no I/O)
// ---------------------------------------------------------------------------

/**
 * Refine existing code given new failures. Returns the next candidate
 * source — typically wraps an LLM call.
 *
 * The signal aborts on caller cancellation OR per-attempt timeout; the
 * loop also races this promise against a deadline so a non-cooperative
 * adapter cannot hang the search. Abort-aware adapters SHOULD still
 * honor the signal to release in-flight work promptly.
 */
export type RefineCallback = (
  currentCode: string,
  failures: readonly EvalFailure[],
  iteration: number,
  maxIterations: number,
  signal: AbortSignal,
) => Promise<string>;

/**
 * Evaluate a variant against test scenarios. Typically wraps a verifier
 * + eval framework. Returns a success rate plus failures for the next
 * refinement.
 *
 * The descriptor is held constant across the entire search — the search
 * loop refines the *implementation*, not the *contract*. Refiners may
 * emit code whose runtime interface drifts from `descriptor`; the
 * evaluator is responsible for catching that and reporting a low
 * success rate / verifier failure. Schema-aware synthesis (mutating the
 * descriptor) is `@koi/harness-synth`'s domain, not search's.
 *
 * Like `RefineCallback`, the signal aborts on caller cancellation OR
 * per-attempt timeout; the loop races against a deadline.
 */
export type EvaluateCallback = (
  code: string,
  descriptor: ToolDescriptor,
  signal: AbortSignal,
) => Promise<EvalResult>;

// ---------------------------------------------------------------------------
// Search config
// ---------------------------------------------------------------------------

/**
 * Sanitizer applied to `EvalFailure[]` before they are forwarded into
 * `refine()`. Failures cross a trust boundary back into the LLM
 * provider — `errorMessage`, `parameters`, and even `errorCode` may
 * contain sandbox stderr, stack traces, user payloads, or tenant data
 * that callers do not want exfiltrated to the model. Mirrors the
 * `sanitizeVerifierReason` pattern in `@koi/harness-synth`.
 *
 * Default ({@link DEFAULT_SEARCH_CONFIG}) drops free-text fields and
 * keeps only `toolName` + `errorCode` for steering the next refinement;
 * callers wrapping trusted in-process evaluators may pass through with
 * `(f) => f`, or supply their own redactor.
 */
export type SanitizeFailures = (failures: readonly EvalFailure[]) => readonly EvalFailure[];

export interface SearchConfig {
  readonly refine: RefineCallback;
  readonly evaluate: EvaluateCallback;
  /** Hard cap on iterations. Default 20. Must be >= 1. */
  readonly maxIterations?: number;
  /** Success rate at/above which a node counts as converged. Default 1.0. */
  readonly convergenceThreshold?: number;
  /** Minimum samples required before convergence is trusted. Default 5. */
  readonly minEvalSamples?: number;
  /** Stop after N consecutive iterations without strict improvement. Default 3. */
  readonly noImprovementLimit?: number;
  /**
   * Per-callback deadline in ms. The loop races each `evaluate` /
   * `refine` invocation against this timeout AND the external `signal`,
   * aborting the per-attempt controller on either trigger and surfacing
   * `eval_timeout` / `refine_timeout` so the bounded-search contract
   * holds even when an injected callback ignores its signal. Default
   * 30_000. Use `Number.POSITIVE_INFINITY` to disable the deadline (only
   * for callbacks proven to be cooperative). Must be a positive number
   * or `Infinity`.
   */
  readonly attemptTimeoutMs?: number;
  /**
   * Sanitizer applied to evaluator failures before they are passed into
   * `refine()`. Default redacts `errorMessage` and `parameters` to
   * prevent caller-controlled data from leaking into the LLM prompt.
   */
  readonly sanitizeFailures?: SanitizeFailures;
  /** Wall-clock source. Default Date.now. */
  readonly clock?: () => number;
  /** PRNG. Default Math.random. */
  readonly random?: () => number;
  /** Optional caller cancellation; aborts between iterations. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Default redactor — keeps `toolName` + `errorCode` for steering
 * refinement, drops `errorMessage` and `parameters`. Both can carry
 * caller-controlled / sandbox-emitted free text or tenant data; the
 * package fails closed on this trust boundary so callers must opt in
 * to passing diagnostic detail through to the model.
 */
const DEFAULT_SANITIZE_FAILURES: SanitizeFailures = (failures) =>
  failures.map((f) => ({
    toolName: f.toolName,
    errorCode: f.errorCode,
    errorMessage: "redacted",
    parameters: {},
  }));

/** Defaults applied when fields are omitted from a partial config. */
export const DEFAULT_SEARCH_CONFIG: Required<
  Pick<
    SearchConfig,
    | "maxIterations"
    | "convergenceThreshold"
    | "minEvalSamples"
    | "noImprovementLimit"
    | "attemptTimeoutMs"
    | "sanitizeFailures"
    | "clock"
    | "random"
  >
> = Object.freeze({
  maxIterations: 20,
  convergenceThreshold: 1.0,
  minEvalSamples: 5,
  noImprovementLimit: 3,
  attemptTimeoutMs: 30_000,
  sanitizeFailures: DEFAULT_SANITIZE_FAILURES,
  clock: Date.now,
  random: Math.random,
});

// ---------------------------------------------------------------------------
// Search result
// ---------------------------------------------------------------------------

/** Why the search stopped. Stable identifiers for routing/telemetry. */
export type StopReason =
  | "converged"
  | "budget_exhausted"
  | "thompson_deploy"
  | "no_improvement"
  | "eval_failed"
  | "eval_timeout"
  | "refine_failed"
  | "refine_timeout"
  | "aborted";

export interface SearchResult {
  /** Best variant found across the search. */
  readonly best: SearchNode;
  /** All variants evaluated, in iteration order. */
  readonly history: readonly SearchNode[];
  readonly stopReason: StopReason;
  /** Number of evaluation cycles completed (== history.length). */
  readonly totalIterations: number;
  /** Whether `best` met both convergence gates. */
  readonly converged: boolean;
}
