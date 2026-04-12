/**
 * @koi/outcome-evaluator — config, handle, and event types.
 */

import type {
  KoiMiddleware,
  OutcomeEvaluation,
  OutcomeRubric,
  SessionId,
  TurnContext,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Grader model call
// ---------------------------------------------------------------------------

/**
 * Pre-bound function that sends a prompt to the grader model and returns its
 * raw text response. The caller (L1 wiring) is responsible for injecting this.
 *
 * Isolated from the agent's conversation history — only receives the prompt
 * constructed by @koi/outcome-evaluator. Supports cancellation via AbortSignal.
 */
export type GraderModelCall = (prompt: string, signal?: AbortSignal) => Promise<string>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OutcomeEvaluatorConfig {
  /** Rubric to evaluate agent output against. */
  readonly rubric: OutcomeRubric;

  /**
   * Pre-bound grader model call. Isolated from agent conversation history.
   * Injected at L1 wiring time (not via the middleware onion).
   */
  readonly graderModelCall: GraderModelCall;

  /**
   * Maximum rubric evaluation iterations (1-indexed). Default: 3. Max: 20.
   * Must be ≤ engineStopRetryCap when provided; must be ≤ EngineInput.maxStopRetries at runtime.
   */
  readonly maxIterations?: number | undefined;

  /**
   * When true, each criterion is evaluated in a separate grader call to prevent
   * halo effects (one criterion biasing another). Increases latency by ~N×.
   * Default: false (single call, all criteria in one prompt).
   */
  readonly isolateCriteria?: boolean | undefined;

  /**
   * Maximum concurrent grader calls when isolateCriteria is true.
   * Default: all criteria in parallel. Set lower to avoid provider rate limits.
   */
  readonly maxConcurrentGraderCalls?: number | undefined;

  /**
   * Circuit breaker: terminate early when the same set of failing required-criterion
   * names appears this many consecutive times. Counter resets when the failing set changes.
   * Default: 2.
   */
  readonly circuitBreakConsecutiveIdenticalFailures?: number | undefined;

  /**
   * Behaviour when the grader call throws or returns unparseable output.
   * - "fail_closed": block completion (safe default; agent stays in loop)
   * - "fail_open": allow completion (agent proceeds despite evaluation failure)
   * Default: "fail_closed".
   */
  readonly onGraderError?: "fail_open" | "fail_closed" | undefined;

  /**
   * Per-grader-call timeout in milliseconds. On timeout the error policy
   * (onGraderError) applies and an "outcome.grader.timeout" event is emitted.
   * Default: 30_000.
   */
  readonly graderTimeoutMs?: number | undefined;

  /**
   * Maximum artifact size in tokens (estimated via @koi/token-estimator).
   * When the captured artifact exceeds this, it is truncated to the last N tokens
   * and an "outcome.artifact.truncated" event is emitted.
   * Default: undefined (no truncation).
   */
  readonly maxArtifactTokens?: number | undefined;

  /**
   * Custom artifact extractor. Receives the TurnContext and the text captured from
   * the last model stream. Return the string to send to the grader.
   * Default: returns capturedText directly; throws KoiRuntimeError if empty.
   */
  readonly artifactCollector?: (ctx: TurnContext, capturedText: string) => string | Promise<string>;

  /**
   * When provided, construction throws KoiRuntimeError("VALIDATION") if
   * maxIterations > engineStopRetryCap. Use to catch misconfiguration early.
   */
  readonly engineStopRetryCap?: number | undefined;

  /**
   * Optional event sink for observability. Called synchronously during evaluation.
   * Use to wire ATIF custom events or structured logging.
   */
  readonly onEvent?: ((event: OutcomeEvaluationEvent) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Handle (returned by factory)
// ---------------------------------------------------------------------------

export interface OutcomeEvaluatorHandle {
  readonly middleware: KoiMiddleware;
  /**
   * Returns a snapshot of evaluation statistics for the given session.
   * Returns zeroed stats for unknown session IDs.
   */
  readonly getStats: (sessionId: SessionId) => OutcomeEvaluatorStats;
}

export interface OutcomeEvaluatorStats {
  readonly totalEvaluations: number;
  readonly satisfied: number;
  readonly circuitBreaks: number;
  readonly graderErrors: number;
}

// ---------------------------------------------------------------------------
// Observable events
// ---------------------------------------------------------------------------

export type OutcomeEvaluationEvent =
  | {
      readonly kind: "outcome.evaluation.start";
      readonly sessionId: string;
      readonly iteration: number;
    }
  | {
      readonly kind: "outcome.evaluation.end";
      readonly sessionId: string;
      readonly evaluation: OutcomeEvaluation;
    }
  | {
      readonly kind: "outcome.artifact.truncated";
      readonly sessionId: string;
      readonly originalTokens: number;
      readonly truncatedTo: number;
    }
  | {
      readonly kind: "outcome.grader.timeout";
      readonly sessionId: string;
      readonly graderTimeoutMs: number;
    };
