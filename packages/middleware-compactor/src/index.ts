/**
 * @koi/middleware-compactor — LLM-based context compaction (Layer 2)
 *
 * Compacts old conversation history into structured summaries when
 * configurable thresholds are exceeded.
 * Depends on @koi/core only.
 */

export type { LlmCompactor } from "./compact.js";
export { createLlmCompactor } from "./compact.js";
export { createCompactorMiddleware } from "./compactor-middleware.js";
export { createMemoryCompactionStore } from "./memory-compaction-store.js";
export type {
  CompactionArchiver,
  CompactionStore,
  CompactionTrigger,
  CompactorConfig,
  OverflowRecoveryConfig,
} from "./types.js";
export { COMPACTOR_DEFAULTS } from "./types.js";
