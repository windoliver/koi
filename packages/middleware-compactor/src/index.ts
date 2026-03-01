/**
 * @koi/middleware-compactor — LLM-based context compaction (Layer 2)
 *
 * Compacts old conversation history into structured summaries when
 * configurable thresholds are exceeded.
 * Depends on @koi/core only.
 */

export type { LlmCompactor } from "./compact.js";
export { createLlmCompactor } from "./compact.js";
export type { CompactContextToolDeps } from "./compact-context-tool.js";
export { createCompactContextTool } from "./compact-context-tool.js";
export type { CompactorBundle } from "./compactor-bundle.js";
export { createCompactorBundle } from "./compactor-bundle.js";
export {
  COMPACTOR_GOVERNANCE,
  createCompactorGovernanceContributor,
} from "./compactor-governance-contributor.js";
export type { CompactorMiddleware } from "./compactor-middleware.js";
export { createCompactorMiddleware } from "./compactor-middleware.js";
export { descriptor } from "./descriptor.js";
export { createFactExtractingArchiver } from "./fact-extracting-archiver.js";
export type {
  ExtractedFact,
  FactExtractionConfig,
  HeuristicPattern,
} from "./fact-extraction.js";
export { DEFAULT_HEURISTIC_PATTERNS } from "./fact-extraction.js";
export { createMemoryCompactionStore } from "./memory-compaction-store.js";
export type { PressureTrendTracker } from "./pressure-trend.js";
export { createPressureTrendTracker } from "./pressure-trend.js";
export type {
  CompactionArchiver,
  CompactionStore,
  CompactionTrigger,
  CompactorConfig,
  OverflowRecoveryConfig,
} from "./types.js";
export { COMPACTOR_DEFAULTS, COMPACTOR_PRESETS } from "./types.js";
