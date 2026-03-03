/**
 * Mutation pressure scoring — maps fitness scores to pressure zones.
 *
 * Pure function, no I/O. Used by forge governance to determine whether
 * a capability space is protected by high-fitness incumbents.
 */

import type { MutationPressure, MutationPressurePolicy } from "@koi/core";
import { DEFAULT_MUTATION_PRESSURE_POLICY } from "@koi/core";

/**
 * Maps a fitness score to a mutation pressure zone.
 *
 * - `> frozenThreshold` → "frozen" (block forge in overlapping capability space)
 * - `>= stableThreshold` → "stable" (normal)
 * - `>= experimentalThreshold` → "experimental" (increased experimentation)
 * - `< experimentalThreshold` → "aggressive" (amplified replacement search)
 *
 * @param fitnessScore - Composite fitness score in [0, 1].
 * @param policy - Optional partial policy overrides (merged with defaults).
 */
export function computeMutationPressure(
  fitnessScore: number,
  policy?: Partial<MutationPressurePolicy>,
): MutationPressure {
  const p: MutationPressurePolicy = { ...DEFAULT_MUTATION_PRESSURE_POLICY, ...policy };

  if (fitnessScore > p.frozenThreshold) {
    return "frozen";
  }
  if (fitnessScore >= p.stableThreshold) {
    return "stable";
  }
  if (fitnessScore >= p.experimentalThreshold) {
    return "experimental";
  }
  return "aggressive";
}
