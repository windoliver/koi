/**
 * @koi/crystallize -- Auto-discovery of repeating tool call patterns (L0u).
 * @packageDocumentation
 *
 * Observes tool call sequences via a `readTraces` callback, detects
 * repeating n-gram patterns, and surfaces crystallization candidates for
 * potential forging as reusable bricks. Never auto-forges -- suggestions only.
 *
 * The forge bridge handler evaluates candidates and produces tool descriptors
 * for high-confidence patterns, ready for the forge pipeline.
 *
 * Depends on @koi/core and @koi/errors.
 */

export type { ScoreConfig } from "./compute-score.js";
export { computeCrystallizeScore } from "./compute-score.js";
export { createCrystallizeMiddleware } from "./crystallize-middleware.js";
export type { DetectPatternsConfig, IncrementalDetectionResult } from "./detect-patterns.js";
export {
  computeSuggestedName,
  detectPatterns,
  detectPatternsIncremental,
  filterSubsumed,
} from "./detect-patterns.js";
export type {
  CrystallizedToolDescriptor,
  CrystallizeForgeConfig,
  CrystallizeForgeHandler,
} from "./forge-handler.js";
export { createCrystallizeForgeHandler } from "./forge-handler.js";
export { generateCompositeImplementation } from "./generate-composite.js";
export type { NgramEntry } from "./ngram.js";
export {
  computeNgramKey,
  extractNgrams,
  extractNgramsIncremental,
  extractToolSequences,
} from "./ngram.js";
export type {
  CrystallizationCandidate,
  CrystallizeConfig,
  CrystallizeHandle,
  ToolNgram,
  ToolStep,
} from "./types.js";
export type { ValidatedCrystallizeConfig } from "./validate-config.js";
export { validateCrystallizeConfig } from "./validate-config.js";
