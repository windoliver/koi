/**
 * Quality scoring for crystallization candidates.
 *
 *   score = occurrences × stepsReduction × recencyBoost × successRate
 *
 * - `stepsReduction` rewards longer sequences: collapsing an n-step pattern
 *   into a single composite tool saves `n-1` LLM decisions.
 * - `recencyBoost` decays exponentially from `detectedAt`; stale patterns lose
 *   priority naturally without explicit eviction.
 * - `successRate` penalizes patterns whose constituent tools fail often. When
 *   no outcome data is available the rate defaults to 1.0 (no penalty).
 */

import type { CrystallizationCandidate, ScoreConfig } from "./types.js";

const DEFAULT_RECENCY_HALF_LIFE_MS = 1_800_000;

/**
 * Fraction of constituent steps with `outcome === "success"`. Returns 1.0 when
 * no step carries outcome data — the absence of evidence is not evidence of
 * failure.
 */
export function computeSuccessRate(candidate: CrystallizationCandidate): number {
  let withOutcome = 0;
  let successes = 0;
  for (const step of candidate.ngram.steps) {
    if (step.outcome !== undefined) {
      withOutcome += 1;
      if (step.outcome === "success") successes += 1;
    }
  }
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
