/**
 * @koi/middleware-collective-memory — Cross-run worker learnings (Layer 2)
 *
 * Extracts reusable learnings from spawn-family tool results, persists them
 * as collective memory on brick artifacts, and injects relevant learnings
 * into future model calls.
 *
 * Depends on @koi/core, @koi/token-estimator, and @koi/validation.
 */

export { createCollectiveMemoryMiddleware } from "./collective-memory-middleware.js";
export { compactCollectiveMemory, shouldCompact } from "./compact.js";
export { createDefaultExtractor } from "./extract-learnings.js";
export { createExtractionPrompt, parseExtractionResponse } from "./extract-llm.js";
export { formatCollectiveMemory } from "./inject.js";
export type {
  CollectiveMemoryMiddlewareConfig,
  LearningCandidate,
  LearningExtractor,
} from "./types.js";
