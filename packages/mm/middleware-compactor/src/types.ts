/**
 * Configuration types for the middleware-compactor package.
 */

import type { MemoryComponent } from "@koi/core";
import type { CompactionResult, TokenEstimator } from "@koi/core/context";
import type { InboundMessage } from "@koi/core/message";
import type { CapabilityFragment, ModelHandler } from "@koi/core/middleware";

/**
 * Archives original messages before they are replaced by a summary.
 * Fire-and-forget: errors are logged but never block compaction.
 */
export interface CompactionArchiver {
  readonly archive: (messages: readonly InboundMessage[], summary: string) => void | Promise<void>;
}

/**
 * Persists compaction results to survive session restarts.
 * Default in-memory implementation ships with the package.
 */
export interface CompactionStore {
  readonly save: (sessionId: string, result: CompactionResult) => void | Promise<void>;
  readonly load: (
    sessionId: string,
  ) => CompactionResult | undefined | Promise<CompactionResult | undefined>;
}

/**
 * Settings for overflow recovery — catches context-overflow errors and retries.
 */
export interface OverflowRecoveryConfig {
  /** Maximum retry attempts after overflow. Default: 1. */
  readonly maxRetries?: number;
}

/**
 * Conditions that trigger compaction. Any satisfied condition fires.
 * All thresholds are optional — at least one must be set.
 */
export interface CompactionTrigger {
  /** Fraction of contextWindowSize (0.0–1.0). Default: 0.60. */
  readonly tokenFraction?: number;
  /** Soft trigger — emits warning only, no compaction. Default: 0.50. */
  readonly softTriggerFraction?: number;
  /** Absolute token count threshold. */
  readonly tokenCount?: number;
  /** Message count threshold. */
  readonly messageCount?: number;
}

/**
 * User-facing configuration for createLlmCompactor / createCompactorMiddleware.
 */
export interface CompactorConfig {
  /** LLM handler used to generate summaries. */
  readonly summarizer: ModelHandler;
  /** Model identifier passed to the summarizer. */
  readonly summarizerModel?: string;
  /** Context window size in tokens. Default: 200_000. */
  readonly contextWindowSize?: number;
  /** When to trigger compaction. Default: { tokenFraction: 0.60, softTriggerFraction: 0.50 }. */
  readonly trigger?: CompactionTrigger;
  /** Number of most recent messages to always preserve. Default: 4. */
  readonly preserveRecent?: number;
  /** Max tokens the summary may occupy. Default: 1000. */
  readonly maxSummaryTokens?: number;
  /** Override the default token estimator (4 chars/token heuristic). */
  readonly tokenEstimator?: TokenEstimator;
  /** Override the default summary prompt builder. */
  readonly promptBuilder?: (
    messages: readonly InboundMessage[],
    maxTokens: number,
    conventions?: readonly CapabilityFragment[],
  ) => string;
  /** Memory component — auto-creates a fact-extracting archiver when set and `archiver` is omitted. */
  readonly memory?: MemoryComponent | undefined;
  /** Archive original messages before summarization. */
  readonly archiver?: CompactionArchiver;
  /** Persistent store for compaction results across sessions. */
  readonly store?: CompactionStore;
  /** Enable overflow recovery — catches context-overflow errors, force-compacts, retries. */
  readonly overflowRecovery?: OverflowRecoveryConfig;
  /** When true, describeCapabilities mentions the compact_context tool. */
  readonly toolEnabled?: boolean;
  /** Convention fragments preserved through compaction cycles. */
  readonly conventions?: readonly CapabilityFragment[] | undefined;
}

/**
 * Fully resolved config with all defaults applied. Internal only.
 */
export interface ResolvedCompactorConfig {
  readonly summarizer: ModelHandler;
  readonly summarizerModel: string | undefined;
  readonly contextWindowSize: number;
  readonly trigger: CompactionTrigger;
  readonly preserveRecent: number;
  readonly maxSummaryTokens: number;
  readonly tokenEstimator: TokenEstimator;
  readonly promptBuilder: (
    messages: readonly InboundMessage[],
    maxTokens: number,
    conventions?: readonly CapabilityFragment[],
  ) => string;
  readonly archiver: CompactionArchiver | undefined;
  readonly overflowRecovery: OverflowRecoveryConfig;
  readonly conventions: readonly CapabilityFragment[];
}

interface CompactorDefaults {
  readonly contextWindowSize: number;
  readonly trigger: CompactionTrigger;
  readonly preserveRecent: number;
  readonly maxSummaryTokens: number;
  readonly overflowRecovery: OverflowRecoveryConfig;
  readonly conventions: readonly CapabilityFragment[];
}

export const COMPACTOR_DEFAULTS: CompactorDefaults = Object.freeze({
  contextWindowSize: 200_000,
  trigger: Object.freeze({ tokenFraction: 0.6, softTriggerFraction: 0.5 }),
  preserveRecent: 4,
  maxSummaryTokens: 1000,
  overflowRecovery: Object.freeze({ maxRetries: 1 }),
  conventions: Object.freeze([]),
});

/** Named presets for common compactor configurations. */
export const COMPACTOR_PRESETS: Readonly<Record<string, Partial<CompactorConfig>>> = Object.freeze({
  /** Pre-v2 behavior: hard trigger at 75%, no soft trigger. */
  aggressive: Object.freeze({
    trigger: Object.freeze({ tokenFraction: 0.75 }),
  }),
});
