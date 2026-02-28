/**
 * Type definitions for @koi/middleware-output-verifier.
 *
 * Two-stage output quality gate: deterministic checks (Stage 1) followed by
 * an LLM-as-judge (Stage 2). Only "block" in Stage 1 short-circuits Stage 2.
 */

import type { KoiMiddleware } from "@koi/core/middleware";

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Action to take when a veto is triggered. */
export type VerifierAction = "block" | "warn" | "revise";

// ---------------------------------------------------------------------------
// Stage 1 — Deterministic checks
// ---------------------------------------------------------------------------

/**
 * A named deterministic check applied to the raw model output string.
 *
 * @example
 * const nonEmpty: DeterministicCheck = {
 *   name: "non-empty",
 *   check: (c) => c.trim().length > 0 || "Output must not be empty",
 *   action: "block",
 * };
 */
export interface DeterministicCheck {
  /** Human-readable name used in veto events for debugging. */
  readonly name: string;
  /**
   * Predicate function.
   * - Return `true` to pass.
   * - Return `false` or a `string` (failure reason) to fail.
   */
  readonly check: (content: string) => boolean | string;
  /** Action to take when this check fails. */
  readonly action: VerifierAction;
}

// ---------------------------------------------------------------------------
// Stage 2 — LLM-as-judge
// ---------------------------------------------------------------------------

/** Configuration for the LLM-as-judge stage. */
export interface JudgeConfig {
  /** Rubric describing what constitutes a high-quality output. */
  readonly rubric: string;
  /**
   * Model call function. Receives the judge prompt and an optional AbortSignal.
   * Must return the raw model response string.
   */
  readonly modelCall: (prompt: string, signal?: AbortSignal) => Promise<string>;
  /**
   * Minimum score required to pass. Outputs scoring below this are vetoed.
   * Range: 0.0–1.0. Default: 0.75 (targeting ~25% veto rate baseline).
   */
  readonly vetoThreshold?: number | undefined;
  /** Action to take when the judge vetoes. Default: "block". */
  readonly action?: VerifierAction | undefined;
  /**
   * Fraction of calls on which the judge runs. Range: 0.0–1.0. Default: 1.0.
   * Set below 1.0 in production to reduce latency at the cost of coverage.
   * Deterministic checks always run regardless of this setting.
   */
  readonly samplingRate?: number | undefined;
  /** Maximum revision attempts before throwing. Default: 1. */
  readonly maxRevisions?: number | undefined;
  /**
   * Maximum characters of judge reasoning injected during revise.
   * Prevents context bloat from verbose judge explanations. Default: 400.
   */
  readonly revisionFeedbackMaxLength?: number | undefined;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Configuration for the output verifier middleware.
 * At least one of `deterministic` or `judge` must be provided.
 */
export interface VerifierConfig {
  /** Stage 1: deterministic checks. Run sequentially; first "block" short-circuits. */
  readonly deterministic?: readonly DeterministicCheck[] | undefined;
  /** Stage 2: LLM-as-judge. Skipped if Stage 1 produced a "block". */
  readonly judge?: JudgeConfig | undefined;
  /** Called whenever a veto or warn is triggered. */
  readonly onVeto?: ((event: VerifierVetoEvent) => void) | undefined;
  /**
   * Maximum characters to buffer for streaming validation. Default: 262144 (256 KB).
   * If the stream exceeds this size, streaming validation is skipped with a warn event.
   */
  readonly maxBufferSize?: number | undefined;
}

// ---------------------------------------------------------------------------
// Veto event
// ---------------------------------------------------------------------------

/** Event fired when a check vetoes or warns on an output. */
export interface VerifierVetoEvent {
  /** Which stage detected the issue. */
  readonly source: "deterministic" | "judge";
  /** Name of the deterministic check that failed (source = "deterministic" only). */
  readonly checkName?: string | undefined;
  /** Failure reason from the check function (source = "deterministic" only). */
  readonly checkReason?: string | undefined;
  /** Action taken (or that would have been taken for streaming degradation). */
  readonly action: VerifierAction;
  /** Judge score (0.0–1.0), present when source = "judge". */
  readonly score?: number | undefined;
  /** Judge reasoning, truncated to revisionFeedbackMaxLength. */
  readonly reasoning?: string | undefined;
  /** Set when the judge threw or returned an unparseable response. */
  readonly judgeError?: string | undefined;
  /**
   * Set to true when streaming degraded "revise" or "block" to "warn".
   * Content was already yielded; retry is impossible.
   */
  readonly degraded?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** Accumulated statistics for the verifier session. Manual reset via Handle. */
export interface VerifierStats {
  /** Total model calls evaluated (regardless of sampling). */
  readonly totalChecks: number;
  /** Calls where action was "block" or "revise" (output was prevented or revised). */
  readonly vetoed: number;
  /** Calls where action was "warn" (output delivered with advisory event). */
  readonly warned: number;
  /** Veto events originating from Stage 1 deterministic checks. */
  readonly deterministicVetoes: number;
  /** Veto events originating from Stage 2 judge. */
  readonly judgeVetoes: number;
  /** Calls where the judge actually ran (affected by samplingRate). */
  readonly judgedChecks: number;
  /** vetoed / totalChecks. Returns 0 when totalChecks = 0. */
  readonly vetoRate: number;
}

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

/** Returned by createOutputVerifierMiddleware. Provides runtime control and stats. */
export interface VerifierHandle {
  /** The KoiMiddleware to add to your agent's middleware chain. */
  readonly middleware: KoiMiddleware;
  /** Returns a snapshot of accumulated stats since last reset. */
  readonly getStats: () => VerifierStats;
  /**
   * Updates the judge rubric for subsequent calls.
   * Takes effect on the next wrapModelCall / wrapModelStream invocation.
   */
  readonly setRubric: (rubric: string) => void;
  /** Resets all stat counters to zero. Call in onSessionStart for per-session tracking. */
  readonly reset: () => void;
}
