/**
 * Confidence scoring for exaptation signals.
 *
 * Pure function — no side effects, no state. Computes a normalized
 * confidence score (0-1) based on divergence, agent diversity, and
 * observation volume.
 */

import type { ExaptationThresholds } from "./types.js";

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Compute confidence score for an exaptation signal.
 *
 * Score = divergenceScore * agentMultiplier * observationMultiplier * weight,
 * clamped to [0, 1].
 *
 * - Agent multiplier: min(agentCount / minDivergentAgents, 2) — caps at 2x
 * - Observation multiplier: min(observationCount / minObservations, 2) — caps at 2x
 *
 * @param divergenceScore - Average Jaccard distance (0-1).
 * @param agentCount - Number of distinct divergent agents.
 * @param observationCount - Total observations for the brick.
 * @param thresholds - Detection thresholds for normalization.
 * @returns Confidence score between 0 and 1.
 */
export function computeExaptationConfidence(
  divergenceScore: number,
  agentCount: number,
  observationCount: number,
  thresholds: ExaptationThresholds,
): number {
  const agentMultiplier =
    thresholds.minDivergentAgents > 0 ? Math.min(agentCount / thresholds.minDivergentAgents, 2) : 1;

  const observationMultiplier =
    thresholds.minObservations > 0 ? Math.min(observationCount / thresholds.minObservations, 2) : 1;

  return Math.min(
    divergenceScore * agentMultiplier * observationMultiplier * thresholds.confidenceWeight,
    1,
  );
}
