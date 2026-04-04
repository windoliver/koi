/**
 * @koi/memory — Session-start memory recall (L2).
 *
 * Scans a memory directory, scores memories by recency and type relevance,
 * fits selections within a token budget, and formats them for system prompt
 * injection.
 *
 * L2 package — depends on @koi/core (L0) and @koi/token-estimator (L0u).
 */

// Format types & functions
export type { FormatOptions } from "./format.js";
export { formatMemorySection, formatSingleMemory } from "./format.js";
// Recall types & functions
export type { RecallConfig, RecallResult } from "./recall.js";
export { recallMemories, selectWithinBudget } from "./recall.js";
// Salience types & functions
export type {
  DecayConfig,
  SalienceConfig,
  ScoredMemory,
  TypeRelevanceWeights,
} from "./salience.js";
export {
  computeDecayScore,
  computeSalience,
  computeTypeRelevance,
  scoreMemories,
} from "./salience.js";
// Scan types & function
export type { MemoryScanConfig, MemoryScanResult, ScannedMemory, SkippedFile } from "./scan.js";
export { scanMemoryDirectory } from "./scan.js";
