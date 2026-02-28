/**
 * Score computation for crystallization candidates.
 *
 * Formula: occurrences * stepsReduction * recencyBoost
 *
 * - stepsReduction: how many LLM decisions are saved (steps - 1)
 * - recencyBoost: exponential decay from detection time (half-life configurable)
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
 * Compute a crystallization score for a candidate.
 * Higher = more likely to be useful as a forged tool.
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

  return candidate.occurrences * stepsReduction * recencyBoost;
}
