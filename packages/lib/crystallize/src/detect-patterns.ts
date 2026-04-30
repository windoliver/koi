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

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`crystallize: ${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

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

function locationKeyOf(loc: {
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnIndex: number;
}): string {
  return JSON.stringify([loc.sessionId, loc.agentId, loc.turnIndex]);
}

/**
 * True when every location in `needle` also appears in `haystack`. Required
 * before subsumption can drop the shorter pattern: shape containment alone
 * is not enough — `[a,b]` and `[a,b,c]` may live in disjoint turns and the
 * shorter must survive as an independent candidate.
 */
function isLocationSubset(
  needle: readonly CrystallizationCandidate["locations"][number][],
  haystack: readonly CrystallizationCandidate["locations"][number][],
): boolean {
  const seen = new Set(haystack.map(locationKeyOf));
  for (const loc of needle) if (!seen.has(locationKeyOf(loc))) return false;
  return true;
}

/**
 * Drop candidates wholly subsumed by a longer candidate. Subsumption now
 * requires three independent conditions:
 *  - **Shape**: longer contains shorter as a contiguous tool-id subsequence.
 *  - **Coverage**: every location of the shorter is also a location of the
 *    longer. Without this, two patterns that happen to share a substring
 *    but live in different turns would silently delete one another.
 *  - **Quality**: longer's `score` is at least the shorter's. Without this,
 *    a longer composite that always fails on its final step (e.g. a
 *    publish-step that never succeeds) would suppress its healthy
 *    successful prefix from the candidate set.
 */
export function filterSubsumed(
  candidates: readonly CrystallizationCandidate[],
): readonly CrystallizationCandidate[] {
  return candidates.filter((candidate) => {
    return !candidates.some(
      (other) =>
        other.ngram.key !== candidate.ngram.key &&
        other.ngram.steps.length > candidate.ngram.steps.length &&
        containsContiguous(other.ngram.steps, candidate.ngram.steps) &&
        isLocationSubset(candidate.locations, other.locations) &&
        (other.score ?? 0) >= (candidate.score ?? 0),
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
    if (entry.locations.length < minOccurrences) continue;
    const base: CrystallizationCandidate = {
      ngram: entry.ngram,
      occurrences: entry.locations.length,
      locations: entry.locations,
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
  const minSize = requirePositiveInteger(
    cfg.minNgramSize ?? DEFAULT_MIN_NGRAM_SIZE,
    "minNgramSize",
  );
  const maxSize = requirePositiveInteger(
    cfg.maxNgramSize ?? DEFAULT_MAX_NGRAM_SIZE,
    "maxNgramSize",
  );
  if (maxSize < minSize) {
    throw new Error(`crystallize: maxNgramSize (${maxSize}) must be >= minNgramSize (${minSize})`);
  }
  const minOccurrences = requirePositiveInteger(
    cfg.minOccurrences ?? DEFAULT_MIN_OCCURRENCES,
    "minOccurrences",
  );
  const maxCandidates = requirePositiveInteger(
    cfg.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
    "maxCandidates",
  );

  const sequences = extractToolSequences(traces);
  const ngramMap = extractNgrams(sequences, minSize, maxSize);
  return buildCandidates(ngramMap, minOccurrences, maxCandidates, clock(), cfg.firstSeenTimes);
}
