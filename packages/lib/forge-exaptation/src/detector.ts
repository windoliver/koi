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

/**
 * Outcome of a `detectDrift` call. Distinguishes a healthy "no drift" window
 * from detector failure modes (invalid configuration, dropped observations
 * leaving too few valid samples). Callers that previously treated `undefined`
 * as "no drift" silently masked detector failures — the explicit shape lets
 * them branch on `kind` and emit telemetry / fail closed.
 */
export type DetectionResult =
  | { readonly kind: "drift"; readonly report: DriftReport }
  | {
      readonly kind: "no-drift";
      readonly observationCount: number;
      readonly droppedCount: number;
    }
  | { readonly kind: "invalid-config"; readonly reason: string };

// ---------------------------------------------------------------------------
// Suggestion
// ---------------------------------------------------------------------------

/**
 * Recommended action.
 *  - `none`               — no drift, detector failure, or no result yet.
 *  - `reclassify`         — single drift window OR borderline divergence:
 *                           rewrite the artifact's description to match
 *                           observed usage.
 *  - `new-artifact`       — drift has persisted across multiple windows
 *                           (`stableWindows ≥ 2`) AND raw average
 *                           divergence is high (`≥ 0.85`, well above the
 *                           detection threshold). Fork a new specialized
 *                           artifact. Gated on raw divergence, NOT on
 *                           saturated severity, so traffic volume alone
 *                           cannot trigger irreversible artifact splits.
 */
export type ExaptationSuggestion =
  | { readonly kind: "none" }
  | { readonly kind: "reclassify"; readonly severity: number }
  | { readonly kind: "new-artifact"; readonly severity: number };

/**
 * Raw average-divergence threshold above which stable drift is "strong enough"
 * to warrant forking a new artifact. Set well above `divergenceThreshold` so
 * minimum-threshold drift cannot escalate via volume alone.
 */
const NEW_ARTIFACT_DIVERGENCE_THRESHOLD = 0.85;
/** Number of independent drift windows required to call drift "stable". */
const STABLE_WINDOW_COUNT = 2;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect purpose drift from a sliding window of observations for a single
 * artifact.
 *
 * Returns a `DetectionResult` discriminated union:
 *   - `kind: "drift"`          — drift report ready for `suggestAction`.
 *   - `kind: "no-drift"`       — healthy window; carries `droppedCount` so
 *                                callers can alert if dropped > tolerated.
 *   - `kind: "invalid-config"` — thresholds rejected; carries human reason.
 *
 * Bad observations (non-finite scores, empty agentId) are filtered, not
 * fatal — a single corrupt sample must not blind the whole window.
 */
export function detectDrift(
  observations: readonly UsagePurposeObservation[],
  thresholds: ExaptationThresholds,
): DetectionResult {
  const configError = describeInvalidThresholds(thresholds);
  if (configError !== undefined) {
    return { kind: "invalid-config", reason: configError };
  }

  // Filter, don't fail-closed: a single malformed observation must not
  // suppress the whole drift window. Bad inputs are dropped, the rest
  // are scored against the same thresholds.
  const valid = observations.filter(isObservationValid);
  const droppedCount = observations.length - valid.length;

  const noDrift = (): DetectionResult => ({
    kind: "no-drift",
    observationCount: valid.length,
    droppedCount,
  });

  if (valid.length < thresholds.minObservations) return noDrift();

  const avgDivergence = computeAverageDivergence(valid);
  if (avgDivergence < thresholds.divergenceThreshold) return noDrift();

  const divergentAgents = countDivergentAgents(valid, thresholds);
  if (divergentAgents < thresholds.minDivergentAgents) return noDrift();

  const severity = computeSeverity(avgDivergence, divergentAgents, valid.length, thresholds);

  return {
    kind: "drift",
    report: {
      kind: "purpose_drift",
      severity,
      avgDivergence,
      divergentAgents,
      observationCount: valid.length,
    },
  };
}

/**
 * Map a detection result (or a bare `DriftReport`) to a recommended action,
 * factoring in how many prior drift windows have already fired for the
 * same artifact (stability evidence).
 *
 * `new-artifact` is gated on raw `avgDivergence ≥ NEW_ARTIFACT_DIVERGENCE_THRESHOLD`
 * (NOT on saturated severity). With the default detection threshold of 0.7 and
 * the fork threshold of 0.85, drift that just barely clears detection cannot
 * escalate to "fork" purely by accumulating more observations or agents.
 */
export function suggestAction(
  input: DetectionResult | DriftReport | undefined,
  stableWindows: number,
): ExaptationSuggestion {
  const report = extractReport(input);
  if (report === undefined) return { kind: "none" };

  if (
    stableWindows >= STABLE_WINDOW_COUNT &&
    report.avgDivergence >= NEW_ARTIFACT_DIVERGENCE_THRESHOLD
  ) {
    return { kind: "new-artifact", severity: report.severity };
  }
  return { kind: "reclassify", severity: report.severity };
}

function extractReport(input: DetectionResult | DriftReport | undefined): DriftReport | undefined {
  if (input === undefined) return undefined;
  if ("kind" in input && input.kind === "drift") return input.report;
  if ("kind" in input && input.kind === "purpose_drift") return input;
  return undefined;
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

/** Returns a human reason when thresholds are invalid, or undefined when OK. */
function describeInvalidThresholds(t: ExaptationThresholds): string | undefined {
  if (!isPositiveInteger(t.minObservations))
    return `minObservations must be a positive integer (got ${String(t.minObservations)})`;
  if (!isPositiveInteger(t.minDivergentAgents))
    return `minDivergentAgents must be a positive integer (got ${String(t.minDivergentAgents)})`;
  if (!isPositiveInteger(t.minObservationsPerAgent))
    return `minObservationsPerAgent must be a positive integer (got ${String(t.minObservationsPerAgent)})`;
  if (!isUnitInterval(t.divergenceThreshold))
    return `divergenceThreshold must be in [0, 1] (got ${String(t.divergenceThreshold)})`;
  if (!isUnitInterval(t.confidenceWeight))
    return `confidenceWeight must be in [0, 1] (got ${String(t.confidenceWeight)})`;
  return undefined;
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
