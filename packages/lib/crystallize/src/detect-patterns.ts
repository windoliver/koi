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

/**
 * True when the `longer` candidate covers every concrete window of the
 * `shorter`, not merely the set of turns the shorter appeared in. For each
 * shorter window at start `s` in turn T, there must exist a longer window
 * at start `l` in turn T such that `l <= s` and `l + longerLen >= s +
 * shorterLen` — i.e. the shorter's window is wholly inside one of the
 * longer's windows in that turn.
 *
 * Required because a single turn can match a shorter pattern multiple
 * times while the longer pattern matches only once (e.g. `[a,b,c,a,b]`
 * has two `[a,b]` windows but one `[a,b,c]` window). Turn-level coverage
 * alone would let the longer pattern erase the shorter despite leaving
 * one of its in-turn occurrences uncovered.
 *
 * Falls back to `false` (do not subsume) when either side lacks
 * `windowsByTurn` data — that field is only absent on hand-crafted
 * fixtures, and the conservative answer there is to keep both candidates.
 */
function coversEveryWindow(
  shorter: CrystallizationCandidate,
  longer: CrystallizationCandidate,
): boolean {
  const shorterWindows = shorter.windowsByTurn;
  const longerWindows = longer.windowsByTurn;
  if (shorterWindows === undefined || longerWindows === undefined) return false;
  const slack = longer.ngram.steps.length - shorter.ngram.steps.length;
  // Caller has already checked shape containment via `containsContiguous`,
  // so `slack >= 0` is guaranteed when we get here.
  for (const [turnKey, shortStarts] of shorterWindows) {
    const longerStarts = longerWindows.get(turnKey);
    if (longerStarts === undefined) return false;
    for (const s of shortStarts) {
      let covered = false;
      for (const l of longerStarts) {
        if (l <= s && s <= l + slack) {
          covered = true;
          break;
        }
      }
      if (!covered) return false;
    }
  }
  return true;
}

/**
 * Reliability dominance for subsumption. The longer pattern must (a) have
 * at least as much outcome evidence as the shorter and (b) be at least as
 * reliable on that evidence. A longer pattern with strictly less evidence
 * never dominates — otherwise a never-executed longer composite would
 * silently erase a healthy prefix that has been observed succeeding many
 * times. When neither side has evidence, dominance trivially holds (both
 * are reliability-unknown and there is nothing to lose).
 */
function reliabilityDominates(
  longer: CrystallizationCandidate,
  shorter: CrystallizationCandidate,
): boolean {
  const lw = longer.outcomeStats.withOutcome;
  const sw = shorter.outcomeStats.withOutcome;
  if (lw < sw) return false;
  if (sw === 0) return true;
  // sw > 0 here, so divisions are well defined.
  const longerRate = longer.outcomeStats.successes / lw;
  const shorterRate = shorter.outcomeStats.successes / sw;
  return longerRate >= shorterRate;
}

/**
 * Drop candidates wholly subsumed by a longer candidate. Subsumption is a
 * blocking decision — once removed, the shorter never resurfaces — so the
 * longer must dominate on every axis the scorer cares about:
 *
 *  - **Shape**: longer contains shorter as a contiguous tool-id subsequence.
 *  - **Occurrence coverage**: every concrete window of the shorter (turn +
 *    start offset) is wholly contained inside some window of the longer in
 *    the same turn. Pure turn-level coverage is unsafe — a turn can match
 *    a shorter pattern multiple times while matching the longer pattern
 *    only once.
 *  - **Reliability dominance**: longer has at least as much outcome
 *    evidence and at least as good a success rate. A longer pattern with
 *    no evidence cannot dominate a shorter that has been observed
 *    succeeding.
 *  - **Final-score dominance**: longer's aggregate `score` is at least the
 *    shorter's. Without this, an older/staler longer pattern could erase
 *    a fresher shorter prefix that the scorer is actively prioritising.
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
        coversEveryWindow(candidate, other) &&
        reliabilityDominates(other, candidate) &&
        (other.score ?? 0) >= (candidate.score ?? 0),
    );
  });
}

/**
 * `firstSeenTimes` is persisted state from prior analysis cycles, so its
 * values may be corrupted (NaN, Infinity, future dates). Treat any non-
 * finite value or value strictly greater than `now` as missing and fall
 * back to `now` — better to lose recency-decay precision than to leak a
 * NaN through the scorer and break sort determinism.
 */
function resolveDetectedAt(
  firstSeenTimes: ReadonlyMap<string, number> | undefined,
  key: string,
  now: number,
): number {
  const stored = firstSeenTimes?.get(key);
  if (stored === undefined || !Number.isFinite(stored) || stored > now) return now;
  return stored;
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
      detectedAt: resolveDetectedAt(firstSeenTimes, entry.ngram.key, now),
      suggestedName: computeSuggestedName(entry.ngram),
      outcomeStats: entry.outcomeStats,
      windowsByTurn: entry.windowsByTurn,
    };
    const score = computeCrystallizeScore(base, now);
    // Defence in depth: if the scorer ever returns a non-finite value
    // (e.g. config corruption upstream), coerce to 0 so sort ordering
    // remains a total order and bad data does not contaminate output.
    raw.push({ ...base, score: Number.isFinite(score) ? score : 0 });
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
