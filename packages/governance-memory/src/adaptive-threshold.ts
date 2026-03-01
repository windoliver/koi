/**
 * Adaptive thresholds — tighten on violations, relax on clean evaluations.
 *
 * Pure functions only. All operations return new objects (immutable).
 */

import type { AdaptiveThresholdConfig } from "./types.js";

// ---------------------------------------------------------------------------
// AdaptiveThreshold — runtime state for a single threshold
// ---------------------------------------------------------------------------

/** Runtime state for a single adaptive threshold. */
export interface AdaptiveThreshold {
  readonly currentValue: number;
  readonly baseValue: number;
  readonly decayRate: number;
  readonly recoveryRate: number;
  readonly floor: number;
  readonly ceiling: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create an adaptive threshold from configuration. Initial value = baseValue. */
export function createAdaptiveThreshold(config: AdaptiveThresholdConfig): AdaptiveThreshold {
  return {
    currentValue: config.baseValue,
    baseValue: config.baseValue,
    decayRate: config.decayRate,
    recoveryRate: config.recoveryRate,
    floor: config.floor,
    ceiling: config.ceiling,
  };
}

// ---------------------------------------------------------------------------
// Adjustment — pure function, returns new object
// ---------------------------------------------------------------------------

/**
 * Adjust threshold based on whether a violation occurred.
 *
 * - violated=true: tighten (multiply by decayRate, clamp to floor)
 * - violated=false: relax (multiply by recoveryRate, clamp to ceiling)
 *
 * Returns a new AdaptiveThreshold — the original is not mutated.
 */
export function adjustThreshold(
  threshold: AdaptiveThreshold,
  violated: boolean,
): AdaptiveThreshold {
  const raw = violated
    ? threshold.currentValue * threshold.decayRate
    : threshold.currentValue * threshold.recoveryRate;

  const clamped = Math.max(threshold.floor, Math.min(threshold.ceiling, raw));

  return {
    currentValue: clamped,
    baseValue: threshold.baseValue,
    decayRate: threshold.decayRate,
    recoveryRate: threshold.recoveryRate,
    floor: threshold.floor,
    ceiling: threshold.ceiling,
  };
}
