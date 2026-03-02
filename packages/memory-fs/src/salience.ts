/**
 * Composite salience scoring for memory recall ranking.
 *
 * Combines similarity, access frequency, and temporal decay into a single
 * ranking signal: `salience = similarity × log(accessCount + 2) × decayScore`
 */
import { computeDecayScore } from "./decay.js";
import type { ScoredCandidate } from "./types.js";

/** Floor for normalized similarity — prevents zero-collapse on the retriever path. */
const SIMILARITY_FLOOR = 0.1;

/**
 * Per-query min-max normalization to [SIMILARITY_FLOOR, 1.0].
 *
 * - Empty input → empty output
 * - Single element or uniform scores → all 1.0
 * - Otherwise rescales to [0.1, 1.0] so the weakest retriever hit still
 *   carries its access-count and decay signals rather than being zeroed out
 */
export function normalizeScores(scores: readonly number[]): readonly number[] {
  if (scores.length === 0) return [];

  // let — need to scan for extremes
  let min = Infinity;
  let max = -Infinity;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }

  const range = max - min;
  if (range === 0) return scores.map(() => 1.0);

  // Rescale to [SIMILARITY_FLOOR, 1.0] so the weakest retriever hit still
  // carries its access-count and decay signals
  const scale = 1.0 - SIMILARITY_FLOOR;
  return scores.map((s) => SIMILARITY_FLOOR + scale * ((s - min) / range));
}

/**
 * Single-candidate salience: `similarity × log(accessCount + 2) × decayScore`.
 *
 * `+2` avoids zero-collapse: `log(1) = 0` would kill score for new facts;
 * `log(2) ≈ 0.693` provides a safe minimum.
 */
export function computeSalienceScore(
  similarity: number,
  accessCount: number,
  decayScore: number,
): number {
  return similarity * Math.log(accessCount + 2) * decayScore;
}

/**
 * Batch salience scoring: normalize raw scores, compute decay, combine.
 *
 * Returns a new array with `.score` replaced by the composite salience value.
 * Does not mutate the input.
 */
export function computeSalienceScores(
  candidates: readonly ScoredCandidate[],
  now: Date,
  config: { readonly halfLifeDays: number },
): readonly ScoredCandidate[] {
  if (candidates.length === 0) return [];

  const rawScores = candidates.map((c) => c.score);
  const normalized = normalizeScores(rawScores);

  return candidates.map((c, i) => {
    const similarity = normalized[i] ?? 1.0;
    const decay = computeDecayScore(c.fact.lastAccessed, now, config.halfLifeDays);
    const salience = computeSalienceScore(similarity, c.fact.accessCount, decay);
    return { fact: c.fact, entity: c.entity, score: salience };
  });
}
