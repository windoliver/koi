/**
 * Pattern detection — composes n-gram extraction, subsumption filtering, and
 * scoring into the public `detectPatterns` entry point.
 *
 * Subsumption: when a longer n-gram has occurrence count ≥ a shorter one it
 * contains, only the longer is kept. This prevents flooding the candidate
 * list with sub-patterns of a richer pattern that already covers them.
 */

import type { TurnTrace } from "@koi/core";
import { computeCrystallizeScore } from "./compute-score.js";
import { extractNgrams, extractToolSequences } from "./ngram.js";
import type {
  CrystallizationCandidate,
  DetectPatternsConfig,
  NgramEntry,
  ToolNgram,
} from "./types.js";

const DEFAULT_MIN_NGRAM_SIZE = 2;
const DEFAULT_MAX_NGRAM_SIZE = 5;
const DEFAULT_MIN_OCCURRENCES = 3;
const DEFAULT_MAX_CANDIDATES = 5;
const SUGGESTED_NAME_MAX_LEN = 60;

/** Generate a human-readable name from an n-gram by joining tool IDs with "-then-". */
export function computeSuggestedName(ngram: ToolNgram): string {
  const parts = ngram.steps.map((s) => s.toolId.replace(/_/g, "-"));
  const joined = parts.join("-then-");
  if (joined.length > SUGGESTED_NAME_MAX_LEN) {
    return `${joined.slice(0, SUGGESTED_NAME_MAX_LEN - 3)}...`;
  }
  return joined;
}

/**
 * Drop candidates that are wholly subsumed by a longer candidate with at
 * least the same occurrence count. The longer pattern carries strictly more
 * information at no statistical cost, so the shorter one is redundant.
 */
export function filterSubsumed(
  candidates: readonly CrystallizationCandidate[],
): readonly CrystallizationCandidate[] {
  return candidates.filter((candidate) => {
    return !candidates.some(
      (other) =>
        other.ngram.key !== candidate.ngram.key &&
        other.ngram.steps.length > candidate.ngram.steps.length &&
        other.occurrences >= candidate.occurrences &&
        other.ngram.key.includes(candidate.ngram.key),
    );
  });
}

function buildCandidates(
  ngramMap: ReadonlyMap<string, NgramEntry>,
  minOccurrences: number,
  maxCandidates: number,
  now: number,
  firstSeenTimes: ReadonlyMap<string, number> | undefined,
): readonly CrystallizationCandidate[] {
  const raw: CrystallizationCandidate[] = [];
  for (const [, entry] of ngramMap) {
    if (entry.turnIndices.length < minOccurrences) continue;
    const candidate: CrystallizationCandidate = {
      ngram: entry.ngram,
      occurrences: entry.turnIndices.length,
      turnIndices: entry.turnIndices,
      detectedAt: firstSeenTimes?.get(entry.ngram.key) ?? now,
      suggestedName: computeSuggestedName(entry.ngram),
    };
    raw.push({ ...candidate, score: computeCrystallizeScore(candidate, now) });
  }

  // Sort: more frequent first, then longer pattern as tiebreak.
  const sorted = [...raw].sort((a, b) => {
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return b.ngram.steps.length - a.ngram.steps.length;
  });
  const filtered = filterSubsumed(sorted);
  return filtered.slice(0, maxCandidates);
}

/**
 * Detect repeating tool-call patterns in `traces`.
 *
 * Returns candidates sorted by occurrence count descending (then length
 * descending), with subsumed patterns removed and the result truncated to
 * `maxCandidates`.
 */
export function detectPatterns(
  traces: readonly TurnTrace[],
  config: DetectPatternsConfig,
  clock: () => number,
): readonly CrystallizationCandidate[] {
  const minSize = config.minNgramSize ?? DEFAULT_MIN_NGRAM_SIZE;
  const maxSize = config.maxNgramSize ?? DEFAULT_MAX_NGRAM_SIZE;
  const minOccurrences = config.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  const maxCandidates = config.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  const sequences = extractToolSequences(traces);
  const ngramMap = extractNgrams(sequences, minSize, maxSize);
  return buildCandidates(ngramMap, minOccurrences, maxCandidates, clock(), config.firstSeenTimes);
}
