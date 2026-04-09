/**
 * @koi/dream — Dream consolidation for Koi agent memory.
 *
 * Offline memory merging, pruning, and upgrade. Designed to be called
 * by a scheduler/daemon when those exist, or directly from CLI/tests.
 */

// Consolidation
export { runDreamConsolidation } from "./consolidate.js";

// Gate
export { shouldDream } from "./gate.js";

// Similarity
export { defaultSimilarity, jaccard } from "./similarity.js";

// Types
export type {
  DreamConfig,
  DreamGateState,
  DreamResult,
  SimilarityFn,
} from "./types.js";
export { DREAM_DEFAULTS } from "./types.js";
