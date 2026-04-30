/**
 * Core types for `@koi/crystallize` — pattern detection over agent turn traces.
 *
 * Scope of this package is the detection core: extract repeating tool-call
 * sequences from `TurnTrace` events, dedupe via subsumption, score by
 * frequency / complexity / recency / success-rate. Middleware, forge bridges,
 * and auto-forge are out of scope here and live in sibling packages.
 */

/** A single tool invocation in a sequence. */
export interface ToolStep {
  readonly toolId: string;
  /** Outcome of the tool call, derived from trace output. */
  readonly outcome?: "success" | "failure" | undefined;
}

/** An ordered sequence of tool steps with a stable deduplication key. */
export interface ToolNgram {
  readonly steps: readonly ToolStep[];
  readonly key: string;
}

/**
 * Aggregated outcome statistics across every occurrence of an n-gram. Counts
 * step-level outcomes (one increment per step that carried `outcome` data),
 * not per-occurrence verdicts — this preserves resolution when occurrences
 * have mixed step outcomes.
 */
export interface OutcomeStats {
  /** Steps with `outcome === "success"` summed across all occurrences. */
  readonly successes: number;
  /** Steps that carried any `outcome` value summed across all occurrences. */
  readonly withOutcome: number;
}

/** N-gram occurrence record — n-gram plus turn indices and aggregated outcomes. */
export interface NgramEntry {
  readonly ngram: ToolNgram;
  readonly turnIndices: readonly number[];
  readonly outcomeStats: OutcomeStats;
}

/** A detected repeating pattern surfaced as a forge candidate. */
export interface CrystallizationCandidate {
  readonly ngram: ToolNgram;
  readonly occurrences: number;
  readonly turnIndices: readonly number[];
  readonly detectedAt: number;
  readonly suggestedName: string;
  /** Aggregated outcome stats across every occurrence — drives success-rate scoring. */
  readonly outcomeStats: OutcomeStats;
  /** Quality score — higher = better forge candidate. Computed by `computeCrystallizeScore`. */
  readonly score?: number | undefined;
}

/** Configuration for `detectPatterns`. */
export interface DetectPatternsConfig {
  /** Minimum n-gram length (inclusive). Default: 2. */
  readonly minNgramSize?: number | undefined;
  /** Maximum n-gram length (inclusive). Default: 5. */
  readonly maxNgramSize?: number | undefined;
  /** Minimum occurrences required to surface a candidate. Default: 3. */
  readonly minOccurrences?: number | undefined;
  /** Cap on returned candidates after sorting + filtering. Default: 5. */
  readonly maxCandidates?: number | undefined;
  /** Optional first-seen timestamps per n-gram key — drives recency decay across analysis cycles. */
  readonly firstSeenTimes?: ReadonlyMap<string, number> | undefined;
}

/** Configuration for `computeCrystallizeScore`. */
export interface ScoreConfig {
  /** Half-life for the recency-decay component, in milliseconds. Default: 30 minutes. */
  readonly recencyHalfLifeMs?: number | undefined;
}
