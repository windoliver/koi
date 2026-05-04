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
  /** Minimum observations before detection can trigger. */
  readonly minObservations: number;
  /** Average Jaccard divergence required (0-1). */
  readonly divergenceThreshold: number;
  /** Minimum distinct agents whose individual divergence ≥ threshold. */
  readonly minDivergentAgents: number;
  /** Severity multiplier weight (0-1) applied to scaled drift score. */
  readonly confidenceWeight: number;
}

/** Sensible defaults — conservative to minimize false positives. */
export const DEFAULT_EXAPTATION_THRESHOLDS: ExaptationThresholds = {
  minObservations: 5,
  divergenceThreshold: 0.7,
  minDivergentAgents: 2,
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
  /** Mean divergence across observations. */
  readonly avgDivergence: number;
  /** Number of distinct agents at or above the divergence threshold. */
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
 * artifact. Returns `undefined` when any criterion is unmet.
 */
export function detectDrift(
  observations: readonly UsagePurposeObservation[],
  thresholds: ExaptationThresholds,
): DriftReport | undefined {
  if (observations.length < thresholds.minObservations) return undefined;

  const avgDivergence = computeAverageDivergence(observations);
  if (avgDivergence < thresholds.divergenceThreshold) return undefined;

  const divergentAgents = countDivergentAgents(observations, thresholds.divergenceThreshold);
  if (divergentAgents < thresholds.minDivergentAgents) return undefined;

  const severity = computeSeverity(avgDivergence, divergentAgents, observations.length, thresholds);

  return {
    kind: "purpose_drift",
    severity,
    avgDivergence,
    divergentAgents,
    observationCount: observations.length,
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

function computeAverageDivergence(observations: readonly UsagePurposeObservation[]): number {
  // let: sum accumulator
  let sum = 0;
  for (const o of observations) sum += o.divergenceScore;
  return sum / observations.length;
}

function countDivergentAgents(
  observations: readonly UsagePurposeObservation[],
  threshold: number,
): number {
  const agents = new Set<string>();
  for (const o of observations) {
    if (o.divergenceScore >= threshold) agents.add(o.agentId);
  }
  return agents.size;
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
