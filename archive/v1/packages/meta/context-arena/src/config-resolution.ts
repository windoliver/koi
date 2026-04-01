/**
 * Config resolution for context-arena.
 *
 * Three-layer merge: L2 defaults (internal to L2 factories) → preset → user overrides.
 * The arena only configures values it coordinates — L2 factories handle their own defaults.
 */

import { createInMemorySnapshotChainStore } from "@koi/snapshot-chain-store";
import { HEURISTIC_ESTIMATOR } from "@koi/token-estimator";
import { computePresetBudget } from "./presets.js";
import type {
  ContextArenaConfig,
  ContextArenaPreset,
  ResolvedContextArenaConfig,
} from "./types.js";

const DEFAULT_PRESET: ContextArenaPreset = "balanced";
const DEFAULT_CONTEXT_WINDOW_SIZE = 200_000;

/**
 * Resolves user config + preset into a fully-specified ResolvedContextArenaConfig.
 *
 * Merge order: preset budget → user overrides (overrides win).
 */
export function resolveContextArenaConfig(config: ContextArenaConfig): ResolvedContextArenaConfig {
  const contextWindowSize = config.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW_SIZE;
  if (!Number.isFinite(contextWindowSize) || contextWindowSize <= 0) {
    throw new Error(
      `contextWindowSize must be a finite positive number, got ${String(contextWindowSize)}`,
    );
  }

  const preset = config.preset ?? DEFAULT_PRESET;
  const budget = computePresetBudget(preset, contextWindowSize);

  return {
    preset,
    contextWindowSize,
    tokenEstimator: config.tokenEstimator ?? HEURISTIC_ESTIMATOR,
    archiver: config.archiver ?? createInMemorySnapshotChainStore(),
    pruningPolicy: config.pruningPolicy,

    // Compactor — user overrides → preset
    compactorTriggerFraction:
      config.compactor?.trigger?.tokenFraction ?? budget.compactorTriggerFraction,
    compactorSoftTriggerFraction:
      config.compactor?.trigger?.softTriggerFraction ?? budget.compactorSoftTriggerFraction,
    compactorPreserveRecent: config.compactor?.preserveRecent ?? budget.compactorPreserveRecent,
    compactorMaxSummaryTokens:
      config.compactor?.maxSummaryTokens ?? budget.compactorMaxSummaryTokens,

    // Context editing — user overrides → preset
    editingTriggerTokenCount:
      config.contextEditing?.triggerTokenCount ?? budget.editingTriggerTokenCount,
    editingNumRecentToKeep: config.contextEditing?.numRecentToKeep ?? budget.editingNumRecentToKeep,

    // Squash — user overrides → preset
    squashPreserveRecent: config.squash?.preserveRecent ?? budget.squashPreserveRecent,
    squashMaxPendingSquashes: config.squash?.maxPendingSquashes ?? budget.squashMaxPendingSquashes,

    // Personalization
    personalizationEnabled: config.personalization?.enabled ?? config.memoryFs !== undefined,
    personalizationRelevanceThreshold: config.personalization?.relevanceThreshold ?? 0.7,
    personalizationMaxPreferenceTokens: config.personalization?.maxPreferenceTokens ?? 500,

    // Hot memory — user overrides → preset
    hotMemoryMaxTokens: config.hotMemory?.maxTokens ?? budget.hotMemoryMaxTokens,
    hotMemoryRefreshInterval: config.hotMemory?.refreshInterval ?? budget.hotMemoryRefreshInterval,
    hotMemoryEnabled: config.memoryFs !== undefined && config.hotMemory?.disabled !== true,

    // Conversation — user overrides → preset
    conversationMaxHistoryTokens:
      config.conversation?.maxHistoryTokens ?? budget.conversationMaxHistoryTokens,
    conversationMaxMessages: config.conversation?.maxMessages ?? 200,
    conversationEnabled: config.threadStore !== undefined && config.conversation?.disabled !== true,

    // Conventions — map raw strings to CapabilityFragment[]
    conventions:
      config.conventions !== undefined && config.conventions.length > 0
        ? config.conventions.map((s) => ({ label: "convention", description: s }))
        : [],

    // Feature flags
    hydratorEnabled: config.hydrator !== undefined,
    memoryFsEnabled: config.memoryFs !== undefined,
    preferenceEnabled: config.preference !== false,
  };
}
