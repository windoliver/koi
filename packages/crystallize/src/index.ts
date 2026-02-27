/**
 * @koi/crystallize — Auto-discovery of repeating tool call patterns (L0u).
 * @packageDocumentation
 *
 * Observes tool call sequences via SnapshotChainStore<TurnTrace>, detects
 * repeating n-gram patterns, and surfaces crystallization candidates for
 * potential forging as reusable bricks. Never auto-forges — suggestions only.
 *
 * Depends on @koi/core only.
 */

export { createCrystallizeMiddleware } from "./crystallize-middleware.js";
export { computeSuggestedName, detectPatterns, filterSubsumed } from "./detect-patterns.js";
export { computeNgramKey, extractNgrams, extractToolSequences } from "./ngram.js";
export type {
  CrystallizationCandidate,
  CrystallizeConfig,
  CrystallizeHandle,
  ToolNgram,
  ToolStep,
} from "./types.js";
