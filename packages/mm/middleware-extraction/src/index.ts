/**
 * @koi/middleware-extraction — Post-turn learning extraction middleware.
 *
 * Extracts reusable knowledge from spawn-family tool outputs and persists
 * them as MemoryRecord entries via MemoryComponent.store().
 */

// LLM extraction
export { createExtractionPrompt, parseExtractionResponse } from "./extract-llm.js";

// Regex extraction
export { createDefaultExtractor, mapCategoryToMemoryType } from "./extract-regex.js";
// Factory
export { createExtractionMiddleware } from "./extraction-middleware.js";

// Sanitization
export { countSecrets, sanitizeForExtraction } from "./sanitize.js";

// Types
export type {
  ExtractionCandidate,
  ExtractionMiddlewareConfig,
  HotMemoryNotifier,
  LearningExtractor,
} from "./types.js";
export { EXTRACTION_DEFAULTS } from "./types.js";
