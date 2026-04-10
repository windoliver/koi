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

export interface ReplacementConfig {
  /** Max tokens per individual tool result before replacement. Default: 12_500. */
  readonly maxResultTokens?: number;
  /** Max aggregate tokens for all tool results in a single message. Default: 50_000. */
  readonly maxMessageTokens?: number;
  /** Number of characters to include in the preview. Default: 2048. */
  readonly previewChars?: number;
}

// User-facing policy config (partial, per-model overrides)
export interface CompactionPolicy {
  readonly softTriggerFraction: number;
  readonly hardTriggerFraction: number;
  readonly prunePreserveLastK: number;
}

export interface CompactionManagerConfig {
  /** Context window size in tokens. Default: 200_000. */
  readonly contextWindowSize?: number;
  readonly modelId?: string;
  readonly globalPolicy?: Partial<CompactionPolicy>;
  readonly perModelPolicy?: Readonly<Record<string, Partial<CompactionPolicy>>>;
  readonly modelWindowOverrides?: Readonly<Record<string, number>>;
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
  /** Content replacement configuration for large tool results. */
  readonly replacement?: ReplacementConfig;
}

// ---------------------------------------------------------------------------
// Resolved config (all defaults applied)
// ---------------------------------------------------------------------------

export interface ResolvedConfig {
  readonly contextWindowSize: number;
  readonly preserveRecent: number;
  readonly prunePreserveLastK: number;
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
  readonly replacement: {
    readonly maxResultTokens: number;
    readonly maxMessageTokens: number;
    readonly previewChars: number;
  };
}

// Resolved, cached in CompactionState
export interface ResolvedCompactionPolicy {
  readonly contextWindow: number;
  readonly softTriggerFraction: number;
  readonly hardTriggerFraction: number;
  readonly prunePreserveLastK: number;
}

// SummaryAnchor for Issue 4
export interface SummaryAnchor {
  readonly fromTimestamp: number;
  readonly toTimestamp: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

// Telemetry events returned from enforceBudget
export type CompactionEvent =
  | {
      readonly kind: "compaction.triggered";
      readonly signal: "micro" | "full";
      readonly tokensBefore: number;
      readonly contextWindow: number;
    }
  | {
      readonly kind: "compaction.completed";
      readonly signal: "micro" | "full";
      readonly tokensBefore: number;
      readonly tokensAfter: number;
      readonly summaryAnchor?: SummaryAnchor;
    }
  | {
      readonly kind: "tool_output.pruned";
      readonly pairsRemoved: number;
      readonly tokensSaved: number;
    };

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
  readonly resolvedPolicy: ResolvedCompactionPolicy;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const COMPACTION_DEFAULTS = {
  contextWindowSize: 200_000,
  preserveRecent: 4,
  prunePreserveLastK: 3,
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
  replacement: {
    maxResultTokens: 12_500,
    maxMessageTokens: 50_000,
    previewChars: 2048,
  },
} as const;

export const INITIAL_STATE: CompactionState = {
  epoch: 0,
  currentTurn: 0,
  lastTokenFraction: 0,
  consecutiveFailures: 0,
  skipUntilTurn: 0,
  resolvedPolicy: {
    contextWindow: 200_000,
    softTriggerFraction: 0.5,
    hardTriggerFraction: 0.75,
    prunePreserveLastK: 3,
  },
};
