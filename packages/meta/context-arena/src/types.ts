/**
 * Configuration, bundle, and preset types for @koi/context-arena.
 *
 * L3 meta-package — imports from L0 (@koi/core) and L2 packages.
 */

import type { ContextHydratorMiddleware, ContextManifestConfig } from "@koi/context";
import type {
  PruningPolicy,
  SnapshotChainStore,
  ThreadMessage,
  ThreadStore,
  TokenEstimator,
} from "@koi/core";
import type { Agent, ComponentProvider, MemoryComponent, SessionId } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  SessionContext,
} from "@koi/core/middleware";
import type { FsMemoryConfig, FsSearchIndexer, FsSearchRetriever } from "@koi/memory-fs";
import type { CompactionTrigger } from "@koi/middleware-compactor";
import type { LlmClassifier } from "@koi/middleware-user-model";

// ---------------------------------------------------------------------------
// Preset
// ---------------------------------------------------------------------------

/** Named budget profiles for context window allocation. */
export type ContextArenaPreset = "conservative" | "balanced" | "aggressive";

// ---------------------------------------------------------------------------
// Config (user-facing)
// ---------------------------------------------------------------------------

/** Per-package override surfaces exposed to the user. */
export interface CompactorOverrides {
  /** Override compaction trigger thresholds. */
  readonly trigger?: CompactionTrigger | undefined;
  /** Override number of recent messages to preserve. */
  readonly preserveRecent?: number | undefined;
  /** Override max summary tokens. */
  readonly maxSummaryTokens?: number | undefined;
}

export interface ContextEditingOverrides {
  /** Override trigger token count. */
  readonly triggerTokenCount?: number | undefined;
  /** Override number of recent tool results to keep. */
  readonly numRecentToKeep?: number | undefined;
}

export interface SquashOverrides {
  /** Override number of recent messages to preserve. */
  readonly preserveRecent?: number | undefined;
  /** Override max pending squash queue depth. */
  readonly maxPendingSquashes?: number | undefined;
}

export interface PersonalizationOverrides {
  /** Enable personalization middleware. Default: false (opt-in). */
  readonly enabled?: boolean | undefined;
  /** Minimum relevance score for preference recall. Default: 0.7. */
  readonly relevanceThreshold?: number | undefined;
  /** Max tokens for injected preferences. Default: 500. */
  readonly maxPreferenceTokens?: number | undefined;
}

export interface HotMemoryOverrides {
  /** Override max tokens for hot memory injection. */
  readonly maxTokens?: number | undefined;
  /** Override turn refresh interval. */
  readonly refreshInterval?: number | undefined;
  /** Set true to disable hot memory even when memoryFs is configured. */
  readonly disabled?: boolean | undefined;
}

export interface ConversationOverrides {
  /** Override max tokens for injected thread history. */
  readonly maxHistoryTokens?: number | undefined;
  /** Override max messages to load from the store. Default: 200. */
  readonly maxMessages?: number | undefined;
  /** Custom thread ID resolver. Falls back to middleware default. */
  readonly resolveThreadId?: ((ctx: SessionContext) => string | undefined) | undefined;
  /** Optional compaction callback applied when messages exceed maxMessages. */
  readonly compact?: ((messages: readonly ThreadMessage[]) => readonly ThreadMessage[]) | undefined;
  /** Set true to disable conversation even when threadStore is configured. */
  readonly disabled?: boolean | undefined;
}

/** User-facing configuration for createContextArena. */
export interface ContextArenaConfig {
  // --- Required ---
  /** LLM handler for compaction summaries. */
  readonly summarizer: ModelHandler;
  /** Session identifier for archive chain naming. */
  readonly sessionId: SessionId;
  /** Returns current conversation messages for squash partitioning. */
  readonly getMessages: () => readonly InboundMessage[];

  // --- Optional core ---
  /** Budget preset. Default: "balanced". */
  readonly preset?: ContextArenaPreset | undefined;
  /** Context window size in tokens. Default: 200_000. */
  readonly contextWindowSize?: number | undefined;
  /** Override the default token estimator. Shared across all middleware. */
  readonly tokenEstimator?: TokenEstimator | undefined;
  /** Memory component for fact extraction (squash + compactor). Overrides memoryFs for extraction when both are provided; memoryFs tools still attach. */
  readonly memory?: MemoryComponent | undefined;
  /** Snapshot archive store. Default: in-memory store. */
  readonly archiver?: SnapshotChainStore<readonly InboundMessage[]> | undefined;
  /** Pruning policy for the snapshot archive. */
  readonly pruningPolicy?: PruningPolicy | undefined;

  // --- Optional dependencies ---
  /** Thread store for conversation history loading/persistence. Gates the conversation middleware. */
  readonly threadStore?: ThreadStore | undefined;

  // --- Per-package overrides ---
  /** Override compactor-specific settings. */
  readonly compactor?: CompactorOverrides | undefined;
  /** Override context-editing-specific settings. */
  readonly contextEditing?: ContextEditingOverrides | undefined;
  /** Override squash-specific settings. */
  readonly squash?: SquashOverrides | undefined;
  /** Override personalization-specific settings. */
  readonly personalization?: PersonalizationOverrides | undefined;
  /** Override conversation-specific settings. Requires threadStore to be configured. */
  readonly conversation?: ConversationOverrides | undefined;

  // --- Opt-in modules ---
  /** Project conventions preserved through compaction. Mapped to CapabilityFragment internally. */
  readonly conventions?: readonly string[] | undefined;
  /** Hot memory injection overrides. Requires memoryFs to be configured. */
  readonly hotMemory?: HotMemoryOverrides | undefined;
  /** Enable context hydrator (deferred — requires Agent at creation time). */
  readonly hydrator?: { readonly config: ContextManifestConfig } | undefined;
  /** Enable filesystem memory. Async initialization. */
  readonly memoryFs?:
    | {
        readonly config: FsMemoryConfig;
        /**
         * Optional semantic search retriever. Overrides `config.retriever` when both set.
         * Create with factories from `@koi/search` or `@koi/search-nexus`.
         */
        readonly retriever?: FsSearchRetriever | undefined;
        /**
         * Optional indexer for automatic fact indexing on store. Overrides `config.indexer` when both set.
         * Create with factories from `@koi/search` or `@koi/search-nexus`.
         */
        readonly indexer?: FsSearchIndexer | undefined;
        /** Enable per-user memory isolation via LRU cache. Reads userId from agent.pid.ownerId. */
        readonly userScoped?: boolean | undefined;
        /** Max cached per-user FsMemory instances when userScoped is true. Default: 100. */
        readonly maxCachedUsers?: number | undefined;
        /** Disable auto-wired LLM merge handler. Default: false (merge enabled when memoryFs is present). */
        readonly disableMerge?: boolean | undefined;
      }
    | undefined;

  // --- Default-on modules ---
  /**
   * Preference drift detection + salience gating.
   * Enabled by default when memory is available. Set to `false` to disable.
   * Provide an LlmClassifier for cascaded (keyword+LLM) detection;
   * omit classify for keyword-only (zero LLM cost).
   */
  readonly preference?: false | { readonly classify?: LlmClassifier | undefined } | undefined;
}

// ---------------------------------------------------------------------------
// Resolved config (internal)
// ---------------------------------------------------------------------------

/** Fully resolved config with all defaults and preset budgets applied. */
export interface ResolvedContextArenaConfig {
  readonly preset: ContextArenaPreset;
  readonly contextWindowSize: number;
  readonly tokenEstimator: TokenEstimator;
  readonly archiver: SnapshotChainStore<readonly InboundMessage[]>;
  readonly pruningPolicy: PruningPolicy | undefined;

  // Compactor
  readonly compactorTriggerFraction: number;
  readonly compactorSoftTriggerFraction: number;
  readonly compactorPreserveRecent: number;
  readonly compactorMaxSummaryTokens: number;

  // Context editing
  readonly editingTriggerTokenCount: number;
  readonly editingNumRecentToKeep: number;

  // Squash
  readonly squashPreserveRecent: number;
  readonly squashMaxPendingSquashes: number;

  // Personalization
  readonly personalizationEnabled: boolean;
  readonly personalizationRelevanceThreshold: number;
  readonly personalizationMaxPreferenceTokens: number;

  // Hot memory
  readonly hotMemoryMaxTokens: number;
  readonly hotMemoryRefreshInterval: number;
  readonly hotMemoryEnabled: boolean;

  // Conversation
  readonly conversationMaxHistoryTokens: number;
  readonly conversationMaxMessages: number;
  readonly conversationEnabled: boolean;

  // Conventions
  readonly conventions: readonly CapabilityFragment[];

  // Feature flags
  readonly hydratorEnabled: boolean;
  readonly memoryFsEnabled: boolean;
  readonly preferenceEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Bundle (return value)
// ---------------------------------------------------------------------------

/** Return value of createContextArena — everything needed to wire into createKoi. */
export interface ContextArenaBundle {
  /** Middleware in priority order: conversation (100, opt-in) → squash (220) → compactor (225) → context-editing (250). */
  readonly middleware: readonly KoiMiddleware[];
  /** Component providers (squash provider + optional memory provider). */
  readonly providers: readonly ComponentProvider[];
  /** Fully resolved configuration for inspection. */
  readonly config: ResolvedContextArenaConfig;
  /** Deferred hydrator factory — call with Agent after createKoi(). Present when hydrator config provided. */
  readonly createHydrator?: (agent: Agent) => ContextHydratorMiddleware;
}

// ---------------------------------------------------------------------------
// Preset spec (internal)
// ---------------------------------------------------------------------------

/** Budget derivation parameters for a single preset. */
export interface PresetSpec {
  /** Compactor hard trigger as fraction of context window. */
  readonly triggerFraction: number;
  /** Distance below hard trigger for soft warning. */
  readonly softTriggerOffset: number;
  /** Shared across compactor + squash. */
  readonly preserveRecent: number;
  /** Max summary tokens as fraction of context window. */
  readonly summaryTokenFraction: number;
  /** Context-editing trigger as fraction of context window. */
  readonly editingTriggerFraction: number;
  /** Tool results to preserve in context-editing. */
  readonly editingRecentToKeep: number;
  /** Squash queue depth. */
  readonly maxPendingSquashes: number;
  /** Hot memory token budget as fraction of context window. */
  readonly hotMemoryTokenFraction: number;
  /** Hot memory turn refresh interval. */
  readonly hotMemoryRefreshInterval: number;
  /** Conversation history token budget as fraction of context window. */
  readonly conversationHistoryFraction: number;
}

/** Computed budget values from a preset + window size. */
export interface PresetBudget {
  readonly compactorTriggerFraction: number;
  readonly compactorSoftTriggerFraction: number;
  readonly compactorPreserveRecent: number;
  readonly compactorMaxSummaryTokens: number;
  readonly editingTriggerTokenCount: number;
  readonly editingNumRecentToKeep: number;
  readonly squashPreserveRecent: number;
  readonly squashMaxPendingSquashes: number;
  readonly hotMemoryMaxTokens: number;
  readonly hotMemoryRefreshInterval: number;
  readonly conversationMaxHistoryTokens: number;
}
