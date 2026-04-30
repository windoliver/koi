/**
 * Pattern detection — composes n-gram extraction, subsumption filtering, and
 * scoring into the public `detectPatterns` entry point.
 *
 * Subsumption: when a longer n-gram contains a shorter one as a contiguous
 * tool-id subsequence and has occurrence count ≥ the shorter, only the
 * longer is kept. The check operates on tokenised step arrays, not the
 * pipe-joined keys, so unrelated patterns whose joined keys happen to share
 * a substring (e.g. `b|c` matching inside `a|b|cd`) are not falsely subsumed.
 */

import type { TurnTrace } from "@koi/core";
import { computeCrystallizeScore } from "./compute-score.js";
import { extractNgrams, extractToolSequences } from "./ngram.js";
import type {
  CrystallizationCandidate,
  DetectPatternsConfig,
  NgramEntry,
  ToolNgram,
  ToolStep,
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

/** True when `needle` appears in `haystack` as a contiguous tool-id subsequence. */
function containsContiguous(haystack: readonly ToolStep[], needle: readonly ToolStep[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j]?.toolId !== needle[j]?.toolId) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
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
        containsContiguous(other.ngram.steps, candidate.ngram.steps),
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
    const base: CrystallizationCandidate = {
      ngram: entry.ngram,
      occurrences: entry.turnIndices.length,
      turnIndices: entry.turnIndices,
      detectedAt: firstSeenTimes?.get(entry.ngram.key) ?? now,
      suggestedName: computeSuggestedName(entry.ngram),
      outcomeStats: entry.outcomeStats,
    };
    raw.push({ ...base, score: computeCrystallizeScore(base, now) });
  }

  // Sort by score desc; occurrences and length break ties so that older,
  // failure-prone patterns can be displaced by fresher, healthier ones even
  // when raw frequency is equal or lower.
  const sorted = [...raw].sort((a, b) => {
    const scoreA = a.score ?? 0;
    const scoreB = b.score ?? 0;
    if (scoreB !== scoreA) return scoreB - scoreA;
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return b.ngram.steps.length - a.ngram.steps.length;
  });
  const filtered = filterSubsumed(sorted);
  return filtered.slice(0, maxCandidates);
}

/**
 * Detect repeating tool-call patterns in `traces`.
 *
 * Returns candidates sorted by quality `score` descending (ties broken by
 * occurrences then length), with subsumed patterns removed and the result
 * truncated to `maxCandidates`.
 */
export function detectPatterns(
  traces: readonly TurnTrace[],
  config: DetectPatternsConfig | undefined,
  clock: () => number,
): readonly CrystallizationCandidate[] {
  const cfg = config ?? {};
  const minSize = cfg.minNgramSize ?? DEFAULT_MIN_NGRAM_SIZE;
  const maxSize = cfg.maxNgramSize ?? DEFAULT_MAX_NGRAM_SIZE;
  const minOccurrences = cfg.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  const maxCandidates = cfg.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  const sequences = extractToolSequences(traces);
  const ngramMap = extractNgrams(sequences, minSize, maxSize);
  return buildCandidates(ngramMap, minOccurrences, maxCandidates, clock(), cfg.firstSeenTimes);
}
