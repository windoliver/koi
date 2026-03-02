/**
 * Pure detection functions for exaptation (purpose drift) triggers.
 *
 * Each heuristic is independently testable — no side effects, no state.
 */

import type { ExaptationKind, UsagePurposeObservation } from "@koi/core";
import type { ExaptationThresholds } from "./types.js";

// ---------------------------------------------------------------------------
// Purpose drift detection
// ---------------------------------------------------------------------------

/**
 * Detect purpose drift from a set of usage observations.
 *
 * Checks three criteria:
 * 1. At least `minObservations` observations exist
 * 2. Average divergence score > `divergenceThreshold`
 * 3. At least `minDivergentAgents` distinct agents show divergence
 *
 * @param observations - Usage observations for a single brick.
 * @param thresholds - Detection thresholds.
 * @returns ExaptationKind if drift detected, undefined otherwise.
 */
export function detectPurposeDrift(
  observations: readonly UsagePurposeObservation[],
  thresholds: ExaptationThresholds,
): ExaptationKind | undefined {
  // Criterion 1: minimum observations
  if (observations.length < thresholds.minObservations) return undefined;

  // Criterion 2: average divergence above threshold
  // let: accumulator for sum
  let divergenceSum = 0;
  for (const obs of observations) {
    divergenceSum += obs.divergenceScore;
  }
  const avgDivergence = divergenceSum / observations.length;
  if (avgDivergence < thresholds.divergenceThreshold) return undefined;

  // Criterion 3: minimum distinct divergent agents
  const divergentAgents = new Set<string>();
  for (const obs of observations) {
    if (obs.divergenceScore >= thresholds.divergenceThreshold) {
      divergentAgents.add(obs.agentId);
    }
  }
  if (divergentAgents.size < thresholds.minDivergentAgents) return undefined;

  return "purpose_drift";
}
