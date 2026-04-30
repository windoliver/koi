/**
 * Quality scoring for crystallization candidates.
 *
 *   score = occurrences × stepsReduction × recencyBoost × successRate
 *
 * - `stepsReduction` rewards longer sequences: collapsing an n-step pattern
 *   into a single composite tool saves `n-1` LLM decisions.
 * - `recencyBoost` decays exponentially from `detectedAt`; stale patterns lose
 *   priority naturally without explicit eviction.
 * - `successRate` reads `candidate.outcomeStats` — the aggregated success /
 *   step counts across every occurrence of the pattern. Scoring on aggregate
 *   stats (not the lone n-gram representative) prevents a single lucky or
 *   unlucky occurrence from skewing the score for a pattern repeated many
 *   times. When no outcome data is available the rate defaults to 1.0.
 */

import type { CrystallizationCandidate, ScoreConfig } from "./types.js";

const DEFAULT_RECENCY_HALF_LIFE_MS = 1_800_000;

/**
 * Aggregated success rate across every occurrence of a pattern. Returns 1.0
 * when no occurrence carried outcome data — the absence of evidence is not
 * evidence of failure.
 */
export function computeSuccessRate(candidate: CrystallizationCandidate): number {
  const { withOutcome, successes } = candidate.outcomeStats;
  if (withOutcome === 0) return 1.0;
  return successes / withOutcome;
}

/** Quality score combining frequency, complexity, recency, and success rate. */
export function computeCrystallizeScore(
  candidate: CrystallizationCandidate,
  now: number,
  config?: ScoreConfig,
): number {
  const halfLife = config?.recencyHalfLifeMs ?? DEFAULT_RECENCY_HALF_LIFE_MS;
  const stepsReduction = Math.max(1, candidate.ngram.steps.length - 1);
  const ageMs = Math.max(0, now - candidate.detectedAt);
  const recencyBoost = 0.5 ** (ageMs / halfLife);
  const successRate = computeSuccessRate(candidate);
  return candidate.occurrences * stepsReduction * recencyBoost * successRate;
}
