/**
 * Pattern detection -- counts n-gram frequencies and surfaces crystallization candidates.
 *
 * Applies subsumption (longer n-grams with the same frequency beat shorter ones they contain),
 * filters by minimum occurrence threshold, and truncates to maxCandidates.
 *
 * Supports both full recomputation (detectPatterns) and incremental mode
 * (detectPatternsIncremental) for efficiency in long sessions.
 */

import type { TurnTrace } from "@koi/core";
import { computeCrystallizeScore } from "./compute-score.js";
import type { NgramEntry } from "./ngram.js";
import { extractNgrams, extractNgramsIncremental, extractToolSequences } from "./ngram.js";
import type { CrystallizationCandidate, ToolNgram } from "./types.js";

// ---------------------------------------------------------------------------
// Default config values
// ---------------------------------------------------------------------------

const DEFAULT_MIN_NGRAM_SIZE = 2;
const DEFAULT_MAX_NGRAM_SIZE = 5;
const DEFAULT_MIN_OCCURRENCES = 3;
const DEFAULT_MAX_CANDIDATES = 5;

// ---------------------------------------------------------------------------
// Suggested name generation
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable suggested name from an n-gram.
 * Joins tool IDs with "then" and truncates long names.
 */
export function computeSuggestedName(ngram: ToolNgram): string {
  const parts = ngram.steps.map((s) => s.toolId.replace(/_/g, "-"));
  const joined = parts.join("-then-");
  // Cap at 60 chars
  if (joined.length > 60) {
    return `${joined.slice(0, 57)}...`;
  }
  return joined;
}

// ---------------------------------------------------------------------------
// Subsumption filter
// ---------------------------------------------------------------------------

/**
 * Filter subsumed n-grams: if a longer n-gram has the same or higher frequency
 * as a shorter one it contains (as a substring of the key), keep only the longer.
 */
export function filterSubsumed(
  candidates: readonly CrystallizationCandidate[],
): readonly CrystallizationCandidate[] {
  const kept: CrystallizationCandidate[] = [];

  for (const candidate of candidates) {
    const isSubsumed = candidates.some(
      (other) =>
        other.ngram.key !== candidate.ngram.key &&
        other.ngram.steps.length > candidate.ngram.steps.length &&
        other.occurrences >= candidate.occurrences &&
        other.ngram.key.includes(candidate.ngram.key),
    );
    if (!isSubsumed) {
      // justified: mutable local array being constructed, not shared state
      kept.push(candidate);
    }
  }

  return kept;
}

// ---------------------------------------------------------------------------
// Config type
// ---------------------------------------------------------------------------

export interface DetectPatternsConfig {
  readonly minNgramSize?: number | undefined;
  readonly maxNgramSize?: number | undefined;
  readonly minOccurrences?: number | undefined;
  readonly maxCandidates?: number | undefined;
}

// ---------------------------------------------------------------------------
// Full detection (recomputes all n-grams from scratch)
// ---------------------------------------------------------------------------

/**
 * Detect repeating tool call patterns in turn traces.
 *
 * @returns Candidates sorted by occurrence count (descending), with subsumed patterns removed.
 */
export function detectPatterns(
  traces: readonly TurnTrace[],
  config: DetectPatternsConfig,
  dismissed: ReadonlySet<string>,
  clock: () => number,
): readonly CrystallizationCandidate[] {
  const minSize = config.minNgramSize ?? DEFAULT_MIN_NGRAM_SIZE;
  const maxSize = config.maxNgramSize ?? DEFAULT_MAX_NGRAM_SIZE;
  const minOccurrences = config.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  const maxCandidates = config.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  const sequences = extractToolSequences(traces);
  const ngramMap = extractNgrams(sequences, minSize, maxSize);
  const now = clock();

  return buildCandidates(ngramMap, minOccurrences, maxCandidates, dismissed, now);
}

// ---------------------------------------------------------------------------
// Incremental detection
// ---------------------------------------------------------------------------

/** Result of incremental pattern detection, including state for next call. */
export interface IncrementalDetectionResult {
  readonly candidates: readonly CrystallizationCandidate[];
  readonly ngramMap: ReadonlyMap<string, NgramEntry>;
  readonly lastProcessedTurnIndex: number;
}

/**
 * Incrementally detect patterns from new traces only, merging into
 * an existing n-gram map. More efficient than full recomputation for
 * long sessions where most turns have already been processed.
 *
 * @param newTraces - Only the new (unprocessed) traces
 * @param startTurnIndex - Global turn index of the first new trace
 * @param existingNgramMap - Previously computed n-gram map
 * @param config - Detection config (min/max sizes, thresholds)
 * @param dismissed - Set of dismissed n-gram keys
 * @param clock - Clock function for timestamps
 */
export function detectPatternsIncremental(
  newTraces: readonly TurnTrace[],
  startTurnIndex: number,
  existingNgramMap: ReadonlyMap<string, NgramEntry>,
  config: DetectPatternsConfig,
  dismissed: ReadonlySet<string>,
  clock: () => number,
): IncrementalDetectionResult {
  const minSize = config.minNgramSize ?? DEFAULT_MIN_NGRAM_SIZE;
  const maxSize = config.maxNgramSize ?? DEFAULT_MAX_NGRAM_SIZE;
  const minOccurrences = config.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  const maxCandidates = config.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  // Extract sequences from new traces only
  const newSequences = extractToolSequences(newTraces);

  // Merge n-grams incrementally
  const mergedMap = extractNgramsIncremental(
    newSequences,
    startTurnIndex,
    existingNgramMap,
    minSize,
    maxSize,
  );

  const now = clock();
  const candidates = buildCandidates(mergedMap, minOccurrences, maxCandidates, dismissed, now);

  const lastProcessedTurnIndex =
    newTraces.length > 0 ? startTurnIndex + newTraces.length - 1 : startTurnIndex - 1;

  return {
    candidates,
    ngramMap: mergedMap,
    lastProcessedTurnIndex,
  };
}

// ---------------------------------------------------------------------------
// Shared candidate builder
// ---------------------------------------------------------------------------

function buildCandidates(
  ngramMap: ReadonlyMap<string, NgramEntry>,
  minOccurrences: number,
  maxCandidates: number,
  dismissed: ReadonlySet<string>,
  now: number,
): readonly CrystallizationCandidate[] {
  const raw: CrystallizationCandidate[] = [];

  for (const [, entry] of ngramMap) {
    if (entry.turnIndices.length >= minOccurrences && !dismissed.has(entry.ngram.key)) {
      const candidate: CrystallizationCandidate = {
        ngram: entry.ngram,
        occurrences: entry.turnIndices.length,
        turnIndices: entry.turnIndices,
        detectedAt: now,
        suggestedName: computeSuggestedName(entry.ngram),
      };
      // justified: mutable local array being constructed, not shared state
      raw.push({
        ...candidate,
        score: computeCrystallizeScore(candidate, now),
      });
    }
  }

  // Sort by occurrences descending, then by longer n-gram first
  const sorted = [...raw].sort((a, b) => {
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return b.ngram.steps.length - a.ngram.steps.length;
  });

  // Subsume shorter patterns
  const filtered = filterSubsumed(sorted);

  // Truncate to max candidates
  return filtered.slice(0, maxCandidates);
}
