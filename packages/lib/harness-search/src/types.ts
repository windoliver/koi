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
 * source as a plain code string — typically wraps an LLM call.
 *
 * Wire-format extraction (fenced code blocks, JSON envelopes,
 * structured tool output) is the CALLER's responsibility: parse the
 * model response inside this callback and return only the candidate
 * source. The search loop does not impose a wire format, so callers
 * pairing this package with `@koi/harness-synth`-style JSON-object
 * responses, fenced-code adapters, or any other contract all share the
 * same surface. See `parseRefinementOutput` in `parse-refinement.ts`
 * for a fenced-code helper if that's the format you want.
 *
 * Returning a non-string, an empty/whitespace-only string, or a string
 * exceeding `maxRefinedCodeBytes` surfaces as `refine_failed`. Throwing
 * is contained as `refine_failed` — useful when the wire format is
 * unparseable.
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
 * provider — `errorMessage`, `parameters`, and `errorCode` may contain
 * sandbox stderr, stack traces, user payloads, or tenant data that
 * callers do not want exfiltrated to the model. Mirrors the
 * `sanitizeVerifierReason` pattern in `@koi/harness-synth`.
 *
 * May be sync or async (`T | Promise<T>`); the search loop races each
 * call against `attemptTimeoutMs` and parent abort, so an async
 * sanitizer that hangs surfaces as `refine_timeout` instead of
 * stalling the whole search. Note: a TRULY synchronous busy loop in
 * the sanitizer body cannot be preempted by the JS event loop, so
 * callers should keep this hook fast or make it async if it does
 * non-trivial traversal.
 *
 * Default ({@link DEFAULT_SEARCH_CONFIG}) redacts every field —
 * including `toolName`, since nothing in the evaluator contract
 * guarantees it isn't a tenant-scoped or user-derived label. Callers
 * wrapping trusted in-process evaluators may pass through with
 * `(f) => f`, or supply a sanitizer that re-includes specific vetted
 * fields (e.g. allowlisting toolName against the frozen descriptor).
 */
export type SanitizeFailures = (
  failures: readonly EvalFailure[],
) => readonly EvalFailure[] | Promise<readonly EvalFailure[]>;

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
   * 30_000. Must be a positive FINITE number — `Infinity` is rejected
   * at config validation because the bounded-termination contract
   * cannot be proven against an uncooperative callback paired with a
   * caller-supplied signal that may never fire.
   */
  readonly attemptTimeoutMs?: number;
  /**
   * Hard byte limit on refined code returned from `parseRefinementOutput`.
   * Refiners are typically LLM-backed and can echo prior code, emit
   * large scaffolding, or hallucinate multi-hundred-KB fences; without
   * a cap, every iteration carries that payload forward in `history`
   * and into the next prompt, blowing up memory and prompt cost.
   * Default 64 KiB. A refinement that exceeds the cap yields
   * `stopReason: "refine_failed"`. Must be a positive integer.
   */
  readonly maxRefinedCodeBytes?: number;
  /**
   * Caller's assertion that BOTH `evaluate` and `refine` honor the
   * `AbortSignal` they receive — i.e. they stop work and release any
   * non-idempotent side effects when aborted. Mirrors the same flag in
   * `@koi/harness-synth`.
   *
   * Default `false`. With the default, `linearSearch` accepts only
   * `maxIterations: 1` (single-shot evaluation): a timed-out or
   * aborted attempt may keep mutating external state in the background,
   * so starting another iteration would overlap side effects.
   * Multi-iteration search REQUIRES `adapterHonorsAbort: true` —
   * passing `maxIterations > 1` without it throws a `TypeError` at
   * config validation. The throw is deliberate: silently downgrading
   * to single-shot when the caller asked for refinement is the worst
   * kind of quiet quality loss.
   *
   * Note: even when `true`, JavaScript cannot truly kill an async
   * callback that ignores its signal — the loop releases its hold on
   * the wall-clock budget within `attemptTimeoutMs`, but a
   * non-cooperative callback may continue running in the background
   * after the search returns. Callers asserting `true` accept that
   * cost as the price of retries.
   */
  readonly adapterHonorsAbort?: boolean;
  /**
   * Sanitizer applied to evaluator failures before they are passed into
   * `refine()`. Default redacts every field (including `toolName`) to
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
 * Default redactor — fails closed on every field. `toolName` is also
 * redacted by default because nothing in the evaluator contract
 * constrains it to a static descriptor identifier: an evaluator using
 * tenant-scoped routing names, user-derived labels, or runtime tool
 * IDs would otherwise forward those strings into the LLM prompt even
 * when every other field is sanitized. Callers wanting to surface a
 * vetted name (e.g. matching the frozen descriptor.name) must supply
 * a custom sanitizer that allowlists it explicitly. `errorCode`,
 * `errorMessage`, and `parameters` are likewise redacted because
 * evaluator code-vocabularies / stderr / payloads can carry tenant
 * identifiers, sandbox paths, or user data. Pass-through `(f) => f`
 * is supported for in-process trusted evaluators.
 */
const DEFAULT_SANITIZE_FAILURES: SanitizeFailures = (failures) =>
  failures.map((_f) => ({
    toolName: "redacted",
    errorCode: "redacted",
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
    | "maxRefinedCodeBytes"
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
  maxRefinedCodeBytes: 64 * 1024,
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

/**
 * Redacted terminal failure diagnostic. Populated only when
 * `stopReason` is a non-success exit (`*_failed`, `*_timeout`,
 * `aborted`); `null` for `converged`, `budget_exhausted`,
 * `no_improvement`, and `thompson_deploy`.
 *
 * Surface deliberately small. Callers driving automated retries /
 * incident triage need to tell *why* a run died (parser drift vs.
 * timeout vs. infra outage vs. genuine refiner failure) without the
 * package leaking error messages, stack traces, or sandbox stderr
 * across the LLM trust boundary. `causeClass` is a static label (e.g.
 * `"TypeError"`, `"RangeError"`) chosen by the runtime, safe to log.
 */
export interface TerminalDiagnostic {
  readonly kind: "eval_failed" | "refine_failed" | "eval_timeout" | "refine_timeout" | "aborted";
  /** Iteration index at which the failure occurred (0-based). */
  readonly iteration: number;
  /**
   * Static error-class label when the failure originated from a thrown
   * exception (callback rejection, sanitizer throw, malformed evaluator
   * payload). `null` for timeouts, abort, and validation rejections
   * where there is no underlying exception to classify.
   */
  readonly causeClass: string | null;
}

export interface SearchResult {
  /**
   * Best variant found across the search. `null` when no evaluation
   * completed — e.g. abort/timeout/eval_failed on the first iteration.
   * Callers MUST handle null before treating the result as a verified
   * candidate; the package deliberately does NOT synthesize a fallback
   * node from `initialCode` because that would be indistinguishable
   * from an evaluated winner and could lead to publishing unverified
   * code after a transient failure.
   */
  readonly best: SearchNode | null;
  /** All variants evaluated, in iteration order. */
  readonly history: readonly SearchNode[];
  readonly stopReason: StopReason;
  /** Number of evaluation cycles completed (== history.length). */
  readonly totalIterations: number;
  /** Whether `best` met both convergence gates. */
  readonly converged: boolean;
  /**
   * Redacted failure diagnostic. Set when `stopReason` is a non-success
   * exit; `null` otherwise. See {@link TerminalDiagnostic}.
   */
  readonly terminalDiagnostic: TerminalDiagnostic | null;
}
