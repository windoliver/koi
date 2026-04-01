/**
 * @koi/context-manager — Context window compaction policy (L2).
 *
 * Tiered thresholds: microcompact (truncation at soft threshold) +
 * full compact (LLM summarization at hard threshold) with exponential
 * backoff on failure.
 *
 * L2 package — depends on @koi/core + L0u utilities only.
 */

export type { BackoffTracker } from "./backoff.js";
export { createBackoffTracker } from "./backoff.js";
export type {
  BudgetConfig,
  BudgetEnforcementResult,
  CompactionSignal,
  ReplacementInfo,
} from "./enforce-budget.js";
export { budgetConfigFromResolved, enforceBudget } from "./enforce-budget.js";
export { findOptimalSplit } from "./find-split.js";
export { microcompact } from "./micro-compact.js";
export { wrapWithOverflowRecovery } from "./overflow-recovery.js";
export type { AssistantToolPair } from "./pair-boundaries.js";
export {
  findValidSplitPoints,
  matchAssistantToolPairs,
  rescuePinnedGroups,
} from "./pair-boundaries.js";
export { shouldCompact } from "./policy.js";
export type { PressureTrendTracker } from "./pressure-trend.js";
export { createPressureTrendTracker } from "./pressure-trend.js";
export type {
  ReplacementEvalConfig,
  ReplacementMessageOutcome,
  ReplacementOutcome,
} from "./replacement.js";
export {
  collectRefsFromOutcomes,
  createInMemoryReplacementStore,
  evaluateMessageResults,
  evaluateReplacement,
  generatePreview,
} from "./replacement.js";
export type { ConfigResult } from "./resolve-config.js";
export { resolveConfig, validateResolvedConfig } from "./resolve-config.js";
export type {
  CompactionDecision,
  CompactionManagerConfig,
  CompactionState,
  ReplacementConfig,
  ResolvedConfig,
} from "./types.js";
export { COMPACTION_DEFAULTS, INITIAL_STATE } from "./types.js";
