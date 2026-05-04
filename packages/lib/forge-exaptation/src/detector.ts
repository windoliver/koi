/**
 * Pure purpose-drift detection over usage observations.
 * Issue #1351 — minimal v2 detector (no middleware, no state).
 *
 * Inputs come from upstream observers (e.g. a future middleware in
 * `@koi/forge-tools` or `@koi/crystallize`). This package only defines
 * the detection algorithm and the action-suggestion policy.
 */

import type { ExaptationKind, UsagePurposeObservation } from "@koi/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Detection thresholds. All fields required to make tuning explicit. */
export interface ExaptationThresholds {
  /** Minimum total observations before detection can trigger (positive integer). */
  readonly minObservations: number;
  /** Average Jaccard divergence required across all observations (in [0, 1]). */
  readonly divergenceThreshold: number;
  /** Minimum distinct agents that independently show drift (positive integer). */
  readonly minDivergentAgents: number;
  /**
   * Per-agent observation floor. An agent only counts as divergent when they
   * have at least this many observations AND their personal average divergence
   * is at or above `divergenceThreshold`. Prevents one-off spikes from
   * manufacturing multi-agent drift (positive integer).
   */
  readonly minObservationsPerAgent: number;
  /** Severity multiplier weight applied to scaled drift score (in [0, 1]). */
  readonly confidenceWeight: number;
}

/** Sensible defaults — conservative to minimize false positives. */
export const DEFAULT_EXAPTATION_THRESHOLDS: ExaptationThresholds = {
  minObservations: 5,
  divergenceThreshold: 0.7,
  minDivergentAgents: 2,
  minObservationsPerAgent: 2,
  confidenceWeight: 0.8,
} as const;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Summary of detected drift. Returned only when criteria are met. */
export interface DriftReport {
  readonly kind: ExaptationKind;
  /** Severity score in [0, 1]. */
  readonly severity: number;
  /** Mean divergence across observations, in [0, 1]. */
  readonly avgDivergence: number;
  /** Number of distinct agents whose own drift evidence cleared the bar. */
  readonly divergentAgents: number;
  /** Total observations evaluated. */
  readonly observationCount: number;
}

// ---------------------------------------------------------------------------
// Suggestion
// ---------------------------------------------------------------------------

/**
 * Recommended action.
 *  - `none`               — no drift / report missing.
 *  - `reclassify`         — single drift window: rewrite the artifact's
 *                           description to match observed usage.
 *  - `new-artifact`       — drift has persisted across multiple windows
 *                           (`stableWindows ≥ 2`) AND severity is high
 *                           (`≥ 0.8`); fork a new specialized artifact.
 */
export type ExaptationSuggestion =
  | { readonly kind: "none" }
  | { readonly kind: "reclassify"; readonly severity: number }
  | { readonly kind: "new-artifact"; readonly severity: number };

/** Severity threshold above which stable drift implies forking. */
const NEW_ARTIFACT_SEVERITY_THRESHOLD = 0.8;
/** Number of independent drift windows required to call drift "stable". */
const STABLE_WINDOW_COUNT = 2;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect purpose drift from a sliding window of observations for a single
 * artifact. Returns `undefined` when any criterion is unmet OR when input
 * is malformed (non-finite scores, out-of-range thresholds, etc.).
 *
 * Validation is deliberately silent — bad input never produces a poisoned
 * `DriftReport` (with `NaN` fields or saturated severity from divide-by-zero).
 * Callers that want loud failure should pre-validate.
 */
export function detectDrift(
  observations: readonly UsagePurposeObservation[],
  thresholds: ExaptationThresholds,
): DriftReport | undefined {
  if (!areThresholdsValid(thresholds)) return undefined;

  // Filter, don't fail-closed: a single malformed observation must not
  // suppress the whole drift window. Bad inputs are dropped, the rest
  // are scored against the same thresholds.
  const valid = observations.filter(isObservationValid);
  if (valid.length < thresholds.minObservations) return undefined;

  const avgDivergence = computeAverageDivergence(valid);
  if (avgDivergence < thresholds.divergenceThreshold) return undefined;

  const divergentAgents = countDivergentAgents(valid, thresholds);
  if (divergentAgents < thresholds.minDivergentAgents) return undefined;

  const severity = computeSeverity(avgDivergence, divergentAgents, valid.length, thresholds);

  return {
    kind: "purpose_drift",
    severity,
    avgDivergence,
    divergentAgents,
    observationCount: valid.length,
  };
}

/**
 * Map a (possibly-undefined) drift report to a recommended action,
 * factoring in how many prior drift windows have already fired for the
 * same artifact (stability evidence).
 */
export function suggestAction(
  report: DriftReport | undefined,
  stableWindows: number,
): ExaptationSuggestion {
  if (report === undefined) return { kind: "none" };

  if (stableWindows >= STABLE_WINDOW_COUNT && report.severity >= NEW_ARTIFACT_SEVERITY_THRESHOLD) {
    return { kind: "new-artifact", severity: report.severity };
  }
  return { kind: "reclassify", severity: report.severity };
}

// ---------------------------------------------------------------------------
// Internals (pure)
// ---------------------------------------------------------------------------

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

function isUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function areThresholdsValid(t: ExaptationThresholds): boolean {
  return (
    isPositiveInteger(t.minObservations) &&
    isPositiveInteger(t.minDivergentAgents) &&
    isPositiveInteger(t.minObservationsPerAgent) &&
    isUnitInterval(t.divergenceThreshold) &&
    isUnitInterval(t.confidenceWeight)
  );
}

function isObservationValid(o: UsagePurposeObservation): boolean {
  if (!isUnitInterval(o.divergenceScore)) return false;
  if (typeof o.agentId !== "string" || o.agentId.length === 0) return false;
  return true;
}

function computeAverageDivergence(observations: readonly UsagePurposeObservation[]): number {
  // let: sum accumulator
  let sum = 0;
  for (const o of observations) sum += o.divergenceScore;
  return sum / observations.length;
}

/**
 * Count agents whose *own* drift evidence clears the bar:
 *   - at least `minObservationsPerAgent` observations attributed to them, AND
 *   - their personal average divergence ≥ `divergenceThreshold`.
 *
 * This rejects the "one-off spike from a second agent fakes multi-agent drift"
 * failure mode: a single borderline observation no longer counts as evidence.
 */
function countDivergentAgents(
  observations: readonly UsagePurposeObservation[],
  thresholds: ExaptationThresholds,
): number {
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const o of observations) {
    sums.set(o.agentId, (sums.get(o.agentId) ?? 0) + o.divergenceScore);
    counts.set(o.agentId, (counts.get(o.agentId) ?? 0) + 1);
  }

  // let: divergent agent counter
  let divergent = 0;
  for (const [agentId, count] of counts) {
    if (count < thresholds.minObservationsPerAgent) continue;
    const sum = sums.get(agentId) ?? 0;
    if (sum / count >= thresholds.divergenceThreshold) divergent++;
  }
  return divergent;
}

function computeSeverity(
  avgDivergence: number,
  divergentAgents: number,
  observationCount: number,
  thresholds: ExaptationThresholds,
): number {
  const agentMultiplier = Math.min(divergentAgents / thresholds.minDivergentAgents, 2);
  const observationMultiplier = Math.min(observationCount / thresholds.minObservations, 2);
  const raw = avgDivergence * agentMultiplier * observationMultiplier;
  const weighted = raw * thresholds.confidenceWeight;
  return Math.min(Math.max(weighted, 0), 1);
}
