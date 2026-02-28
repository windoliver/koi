/**
 * Configuration, bundle, and preset types for @koi/context-arena.
 *
 * L3 meta-package — imports from L0 (@koi/core) and L2 packages.
 */

import type { ContextHydratorMiddleware, ContextManifestConfig } from "@koi/context";
import type { PruningPolicy, SnapshotChainStore, TokenEstimator } from "@koi/core";
import type { Agent, ComponentProvider, MemoryComponent, SessionId } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { KoiMiddleware, ModelHandler } from "@koi/core/middleware";
import type { FsMemoryConfig } from "@koi/memory-fs";
import type { CompactionTrigger } from "@koi/middleware-compactor";

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
  /** Memory component for squash fact extraction. */
  readonly memory?: MemoryComponent | undefined;
  /** Snapshot archive store. Default: in-memory store. */
  readonly archiver?: SnapshotChainStore<readonly InboundMessage[]> | undefined;
  /** Pruning policy for the snapshot archive. */
  readonly pruningPolicy?: PruningPolicy | undefined;

  // --- Per-package overrides ---
  /** Override compactor-specific settings. */
  readonly compactor?: CompactorOverrides | undefined;
  /** Override context-editing-specific settings. */
  readonly contextEditing?: ContextEditingOverrides | undefined;
  /** Override squash-specific settings. */
  readonly squash?: SquashOverrides | undefined;

  // --- Opt-in modules ---
  /** Enable context hydrator (deferred — requires Agent at creation time). */
  readonly hydrator?: { readonly config: ContextManifestConfig } | undefined;
  /** Enable filesystem memory. Async initialization. */
  readonly memoryFs?: { readonly config: FsMemoryConfig } | undefined;
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

  // Feature flags
  readonly hydratorEnabled: boolean;
  readonly memoryFsEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Bundle (return value)
// ---------------------------------------------------------------------------

/** Return value of createContextArena — everything needed to wire into createKoi. */
export interface ContextArenaBundle {
  /** Middleware in priority order: squash (220) → compactor (225) → context-editing (250). */
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
}
