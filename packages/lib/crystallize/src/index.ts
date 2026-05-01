/**
 * @koi/crystallize — pattern detection over agent turn traces.
 *
 * Detects repeating tool-call sequences, deduplicates via subsumption, and
 * scores candidates by frequency × complexity × recency × success-rate. This
 * package is the *detection core*; middleware and forge-bridge wiring live in
 * sibling packages and are added in later phases.
 */

export { computeCrystallizeScore, computeSuccessRate } from "./compute-score.js";
export { computeSuggestedName, detectPatterns, filterSubsumed } from "./detect-patterns.js";
export { computeNgramKey, extractNgrams, extractToolSequences } from "./ngram.js";
export type {
  CrystallizationCandidate,
  DetectPatternsConfig,
  NgramEntry,
  ScoreConfig,
  ToolNgram,
  ToolStep,
} from "./types.js";
