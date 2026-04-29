/**
 * Type definitions for @koi/middleware-output-verifier.
 *
 * Two-stage output quality gate: deterministic checks (Stage 1) followed by
 * an optional LLM-as-judge (Stage 2). Three actions: block, warn, revise.
 */

import type { KoiMiddleware } from "@koi/core/middleware";

/** Action to take when a check fails or judge vetoes. */
export type VerifierAction = "block" | "warn" | "revise";

/**
 * A named deterministic check applied to the assembled model output string.
 *
 * Return `true` to pass. Return `false` or a string (failure reason) to fail.
 */
export interface DeterministicCheck {
  readonly name: string;
  readonly check: (content: string) => boolean | string;
  readonly action: VerifierAction;
}

/** Configuration for the LLM-as-judge stage. */
export interface JudgeConfig {
  /** Quality criteria the judge uses to score. */
  readonly rubric: string;
  /** Raw model invocation; receives the assembled judge prompt, returns raw text. */
  readonly modelCall: (prompt: string, signal?: AbortSignal) => Promise<string>;
  /** Minimum score (0.0–1.0) required to pass. Default: 0.75. */
  readonly vetoThreshold?: number | undefined;
  /** Action when score < threshold. Default: "block". */
  readonly action?: VerifierAction | undefined;
  /** Fraction of calls on which judge runs (0.0–1.0). Default: 1.0. */
  readonly samplingRate?: number | undefined;
  /** Max revision attempts before throwing. Default: 1. */
  readonly maxRevisions?: number | undefined;
  /** Max characters of judge reasoning injected on revise. Default: 400. */
  readonly revisionFeedbackMaxLength?: number | undefined;
  /**
   * Random number generator used for sampling (returns [0, 1)). Default: Math.random.
   * Inject a deterministic function in tests for reproducibility.
   */
  readonly randomFn?: (() => number) | undefined;
}

/**
 * Configuration for the output verifier middleware.
 * At least one of `deterministic` or `judge` must be provided.
 */
export interface VerifierConfig {
  /** Stage 1: deterministic checks. Run sequentially. */
  readonly deterministic?: readonly DeterministicCheck[] | undefined;
  /** Stage 2: LLM-as-judge. */
  readonly judge?: JudgeConfig | undefined;
  /** Called whenever a veto, warn, or revise event fires. */
  readonly onVeto?: ((event: VerifierVetoEvent) => void) | undefined;
  /** Max stream buffer (characters) before validation is skipped. Default: 262144. */
  readonly maxBufferSize?: number | undefined;
}

/** Event fired when a check vetoes, warns, or requests revision. */
export interface VerifierVetoEvent {
  readonly source: "deterministic" | "judge";
  readonly action: VerifierAction;
  readonly checkName?: string | undefined;
  readonly checkReason?: string | undefined;
  readonly score?: number | undefined;
  readonly reasoning?: string | undefined;
  readonly judgeError?: string | undefined;
  /** Set when streaming downgraded block/revise → warn. */
  readonly degraded?: boolean | undefined;
}

/** Accumulated per-session statistics. */
export interface VerifierStats {
  readonly totalChecks: number;
  readonly vetoed: number;
  readonly warned: number;
  readonly deterministicVetoes: number;
  readonly judgeVetoes: number;
  readonly judgedChecks: number;
  readonly vetoRate: number;
}

/** Returned by createOutputVerifierMiddleware. Provides runtime control + stats. */
export interface VerifierHandle {
  readonly middleware: KoiMiddleware;
  readonly getStats: () => VerifierStats;
  /**
   * Set a session-scoped judge rubric override. The override applies only to
   * verification calls whose TurnContext.session.sessionId matches the given
   * id. Other concurrent sessions continue to evaluate against the rubric
   * captured at construction time. Use this for tenant-/session-specific
   * tuning without leaking criteria across boundaries.
   */
  readonly setRubric: (sessionId: string, rubric: string) => void;
  /** Clear a previously-set session rubric override; falls back to the default rubric. */
  readonly clearRubric: (sessionId: string) => void;
  /** Zero all stat counters. */
  readonly reset: () => void;
}

/** Result of parsing a judge response. Fail-closed: parse error → score 0. */
export interface JudgeResult {
  readonly score: number;
  readonly reasoning: string;
  readonly parseError?: string | undefined;
}
