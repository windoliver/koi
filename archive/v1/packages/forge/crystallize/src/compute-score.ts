/**
 * Score computation for crystallization candidates.
 *
 * Formula: occurrences * stepsReduction * recencyBoost * successRate
 *
 * - stepsReduction: how many LLM decisions are saved (steps - 1)
 * - recencyBoost: exponential decay from detection time (half-life configurable)
 * - successRate: fraction of steps with successful outcomes (defaults to 1.0 when no data)
 */

import type { CrystallizationCandidate } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ScoreConfig {
  /** Half-life for recency decay in milliseconds. Default: 1_800_000 (30 min). */
  readonly recencyHalfLifeMs?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_RECENCY_HALF_LIFE_MS = 1_800_000; // 30 minutes

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

/**
 * Compute the success rate for an n-gram's steps.
 * Returns 1.0 when no outcome data is available (backward compat).
 */
export function computeSuccessRate(candidate: CrystallizationCandidate): number {
  const steps = candidate.ngram.steps;
  let withOutcome = 0;
  let successes = 0;
  for (const step of steps) {
    if (step.outcome !== undefined) {
      withOutcome += 1;
      if (step.outcome === "success") {
        successes += 1;
      }
    }
  }
  // No outcome data → default success rate 1.0 (backward compat)
  if (withOutcome === 0) return 1.0;
  return successes / withOutcome;
}

/**
 * Compute a crystallization score for a candidate.
 * Higher = more likely to be useful as a forged tool.
 *
 * Formula: occurrences * stepsReduction * recencyBoost * successRate
 */
export function computeCrystallizeScore(
  candidate: CrystallizationCandidate,
  now: number,
  config?: ScoreConfig,
): number {
  const halfLife = config?.recencyHalfLifeMs ?? DEFAULT_RECENCY_HALF_LIFE_MS;

  // Steps reduction: how many LLM decisions are saved
  const stepsReduction = Math.max(1, candidate.ngram.steps.length - 1);

  // Recency boost: exponential decay from detection time
  const ageMs = Math.max(0, now - candidate.detectedAt);
  const recencyBoost = 0.5 ** (ageMs / halfLife);

  // Success rate: penalize patterns with failures
  const successRate = computeSuccessRate(candidate);

  return candidate.occurrences * stepsReduction * recencyBoost * successRate;
}
