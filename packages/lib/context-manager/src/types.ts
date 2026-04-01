/**
 * Configuration and state types for the context-manager package.
 */

import type { TokenEstimator } from "@koi/core";

// ---------------------------------------------------------------------------
// Compaction decision
// ---------------------------------------------------------------------------

/** Result of the policy decision function. */
export type CompactionDecision = "noop" | "micro" | "full";

// ---------------------------------------------------------------------------
// Config — nested by concern
// ---------------------------------------------------------------------------

export interface MicroCompactConfig {
  /** Fraction of contextWindowSize that triggers microcompact. Default: 0.50. */
  readonly triggerFraction?: number;
  /** Target fraction after microcompact. Default: 0.35. */
  readonly targetFraction?: number;
  /** Microcompact strategy. Default: "truncate". */
  readonly strategy?: "truncate" | "summarize";
}

export interface FullCompactConfig {
  /** Fraction of contextWindowSize that triggers full compact. Default: 0.75. */
  readonly triggerFraction?: number;
  /** Max tokens the LLM summary may occupy. Default: 1000. */
  readonly maxSummaryTokens?: number;
}

export interface BackoffConfig {
  /** Initial turns to skip after first failure. Default: 1. */
  readonly initialSkip?: number;
  /** Maximum turns to skip (cap). Default: 32. */
  readonly cap?: number;
}

export interface CompactionManagerConfig {
  /** Context window size in tokens. Default: 200_000. */
  readonly contextWindowSize?: number;
  /** Number of most recent messages to always preserve. Default: 4. */
  readonly preserveRecent?: number;
  /** Override the default token estimator (4 chars/token heuristic). */
  readonly tokenEstimator?: TokenEstimator;
  /** Microcompact tier configuration. */
  readonly micro?: MicroCompactConfig;
  /** Full compact tier configuration. */
  readonly full?: FullCompactConfig;
  /** Backoff configuration for repeated failures. */
  readonly backoff?: BackoffConfig;
}

// ---------------------------------------------------------------------------
// Resolved config (all defaults applied)
// ---------------------------------------------------------------------------

export interface ResolvedConfig {
  readonly contextWindowSize: number;
  readonly preserveRecent: number;
  readonly tokenEstimator: TokenEstimator;
  readonly micro: {
    readonly triggerFraction: number;
    readonly targetFraction: number;
    readonly strategy: "truncate" | "summarize";
  };
  readonly full: {
    readonly triggerFraction: number;
    readonly maxSummaryTokens: number;
  };
  readonly backoff: {
    readonly initialSkip: number;
    readonly cap: number;
  };
}

// ---------------------------------------------------------------------------
// Compaction state — explicit, immutably updated
// ---------------------------------------------------------------------------

export interface CompactionState {
  /** Compaction cycle count (incremented after each successful full compact). */
  readonly epoch: number;
  /** Current turn number. */
  readonly currentTurn: number;
  /** Last observed token fraction (0.0–1.0). */
  readonly lastTokenFraction: number;
  /** Consecutive compaction failures (reset on success). */
  readonly consecutiveFailures: number;
  /** Turn number at which backoff expires and compaction is retried. */
  readonly skipUntilTurn: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const COMPACTION_DEFAULTS = {
  contextWindowSize: 200_000,
  preserveRecent: 4,
  micro: {
    triggerFraction: 0.5,
    targetFraction: 0.35,
    strategy: "truncate" as const,
  },
  full: {
    triggerFraction: 0.75,
    maxSummaryTokens: 1000,
  },
  backoff: {
    initialSkip: 1,
    cap: 32,
  },
} as const;

export const INITIAL_STATE: CompactionState = {
  epoch: 0,
  currentTurn: 0,
  lastTokenFraction: 0,
  consecutiveFailures: 0,
  skipUntilTurn: 0,
};
