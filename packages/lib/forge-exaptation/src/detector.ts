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

/** Detection thresholds. All numeric fields required to make tuning explicit. */
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
  /**
   * Optional identity function for replay protection.
   *
   * When supplied, the detector dedupes per-agent (`(agentId, keyFn(o))`)
   * before scoring so at-least-once delivery cannot fabricate drift evidence.
   * A throwing `keyFn` is treated as a malformed observation — that sample
   * is dropped, never the whole window.
   *
   * Without this, no dedup runs and the resulting `DetectionResult` is
   * marked `replayProtected: false`. `suggestAction` will refuse to emit
   * `reclassify` or `new-artifact` for unprotected results: a retried
   * high-divergence event could otherwise satisfy `minObservations` AND
   * `minDivergentAgents` purely from transport replays.
   */
  readonly observationKey?: ((o: UsagePurposeObservation) => string) | undefined;
}

/**
 * Default `observationKey`. Returns `${observedAt}|${contextText}` (the
 * agentId is added by per-agent dedup scoping, so the key need only be
 * unique within an agent). Suitable when upstream observers control
 * `observedAt` per tool call and don't replay events with identical
 * timestamps; callers with a stronger event ID should pass their own.
 */
export const DEFAULT_OBSERVATION_KEY = (o: UsagePurposeObservation): string =>
  `${String(o.observedAt)}|${o.contextText}`;

/** Sensible defaults — conservative to minimize false positives. */
export const DEFAULT_EXAPTATION_THRESHOLDS: ExaptationThresholds = {
  minObservations: 5,
  divergenceThreshold: 0.7,
  minDivergentAgents: 2,
  minObservationsPerAgent: 2,
  confidenceWeight: 0.8,
  observationKey: DEFAULT_OBSERVATION_KEY,
} as const;

/**
 * Maximum tolerated fraction of low-quality observations in a single window.
 * `suggestAction` returns `none` when (dropped + duplicates) /
 * (dropped + duplicates + valid) exceeds this ratio — refusing to recommend
 * irreversible actions from windows where most evidence was thrown away.
 */
const MAX_QUALITY_DEGRADATION_RATIO = 0.25;

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
 * leaving too few valid samples). Both `drift` and `no-drift` carry sample-
 * quality telemetry (`droppedCount`, `duplicateCount`) so callers can refuse
 * to act on low-quality windows.
 */
export type DetectionResult =
  | {
      readonly kind: "drift";
      readonly report: DriftReport;
      readonly droppedCount: number;
      readonly duplicateCount: number;
      /**
       * Total post-dedup valid observations in the window — including baseline
       * traffic outside the divergent cohort. Used by `suggestAction`'s quality
       * gate so that clean baseline-heavy windows aren't punished for the
       * cohort being a small slice.
       */
      readonly validObservationCount: number;
      /** False when no `observationKey` was provided — `suggestAction` will refuse. */
      readonly replayProtected: boolean;
    }
  | {
      readonly kind: "no-drift";
      readonly observationCount: number;
      readonly validObservationCount: number;
      readonly droppedCount: number;
      readonly duplicateCount: number;
      readonly replayProtected: boolean;
    }
  | { readonly kind: "invalid-config"; readonly reason: string };

// ---------------------------------------------------------------------------
// Suggestion
// ---------------------------------------------------------------------------

/**
 * Recommended action.
 *  - `none`               — no drift, detector failure, or low-quality window.
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

  // Validate observations and compute each dedup key exactly once. A
  // throwing `observationKey` callback is treated as malformed input —
  // that sample is dropped, never the whole window. Caching the key here
  // also rules out non-deterministic / stateful keyFns that succeed on
  // the first call and throw on the second.
  const keyFn = thresholds.observationKey;
  const validWithMaybeKey: UsagePurposeObservation[] = [];
  const keys: string[] = [];
  for (const o of observations) {
    if (!isObservationValid(o)) continue;
    if (keyFn === undefined) {
      validWithMaybeKey.push(o);
      continue;
    }
    let key: string;
    try {
      key = keyFn(o);
    } catch {
      continue;
    }
    validWithMaybeKey.push(o);
    keys.push(key);
  }
  const droppedCount = observations.length - validWithMaybeKey.length;

  // Dedup is opt-in AND scoped per-agent. Bucketing by agentId before dedup
  // makes payload-only keys safe — identical outputs from different agents
  // always survive.
  const unique =
    keyFn === undefined ? validWithMaybeKey : dedupePerAgentByKey(validWithMaybeKey, keys);
  const duplicateCount = validWithMaybeKey.length - unique.length;
  const replayProtected = keyFn !== undefined;

  const noDrift = (): DetectionResult => ({
    kind: "no-drift",
    observationCount: unique.length,
    validObservationCount: unique.length,
    droppedCount,
    duplicateCount,
    replayProtected,
  });

  if (unique.length < thresholds.minObservations) return noDrift();

  // Identify the divergent cohort first, then score drift on *their*
  // observations only. The earlier "global avgDivergence ≥ threshold" gate
  // hid real drift whenever low-divergence baseline traffic dominated the
  // window — exactly the mixed-workload case this package must surface.
  const cohort = computeDivergentCohort(unique, thresholds);
  if (cohort.agentCount < thresholds.minDivergentAgents) return noDrift();
  // Cohort-level minObservations gate: the *cohort* must have at least
  // minObservations samples — not just the whole window. Otherwise unrelated
  // baseline traffic could pad the window past the threshold and let a
  // tiny cohort trigger drift.
  if (cohort.observationCount < thresholds.minObservations) return noDrift();

  const cohortAvgDivergence = cohort.totalDivergence / cohort.observationCount;
  if (cohortAvgDivergence < thresholds.divergenceThreshold) return noDrift();

  const severity = computeSeverity(
    cohortAvgDivergence,
    cohort.agentCount,
    cohort.observationCount,
    thresholds,
  );

  return {
    kind: "drift",
    droppedCount,
    duplicateCount,
    validObservationCount: unique.length,
    replayProtected,
    report: {
      kind: "purpose_drift",
      severity,
      avgDivergence: cohortAvgDivergence,
      divergentAgents: cohort.agentCount,
      observationCount: cohort.observationCount,
    },
  };
}

/**
 * Map a detection result to a recommended action.
 *
 * Only `DetectionResult` is accepted (NOT a bare `DriftReport`), so the
 * dropped/duplicate quality gate is mandatory and cannot be bypassed by
 * persisting just the report and replaying it later. Callers that hand off
 * a positive recommendation must hand off the full `DetectionResult`.
 *
 * Behaviour:
 *   - `none` for `no-drift`, `invalid-config`, or `undefined`.
 *   - `none` for `drift` results whose dropped + duplicate fraction exceeds
 *     `MAX_QUALITY_DEGRADATION_RATIO` (default 25%).
 *   - `new-artifact` requires `stableWindows ≥ 2` AND raw `avgDivergence ≥
 *     NEW_ARTIFACT_DIVERGENCE_THRESHOLD` (0.85). Gated on raw divergence,
 *     not on saturated `severity`, so traffic volume alone cannot escalate.
 *   - `reclassify` otherwise.
 */
export function suggestAction(
  input: DetectionResult | undefined,
  stableWindows: number,
): ExaptationSuggestion {
  if (input === undefined || input.kind !== "drift") return { kind: "none" };

  // Replay protection is mandatory for action-bearing results. A
  // detector run without `observationKey` could have scored retried
  // events as independent evidence; refuse to recommend action.
  if (!input.replayProtected) return { kind: "none" };

  // Quality gate is mandatory: refuse to act on a window where most
  // observations were dropped or collapsed as duplicates. The denominator
  // is the *full* validated window (not just the divergent cohort) so a
  // clean baseline-heavy window isn't punished for the cohort being a
  // small slice.
  const total = input.validObservationCount + input.droppedCount + input.duplicateCount;
  const lowQuality = input.droppedCount + input.duplicateCount;
  if (total > 0 && lowQuality / total > MAX_QUALITY_DEGRADATION_RATIO) {
    return { kind: "none" };
  }

  const report = input.report;
  if (
    stableWindows >= STABLE_WINDOW_COUNT &&
    report.avgDivergence >= NEW_ARTIFACT_DIVERGENCE_THRESHOLD
  ) {
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

/**
 * Dedup observations per agent using precomputed keys. The dedup namespace
 * is `(agentId, key)`, so identical payloads from different agents survive.
 *
 * `keys[i]` is the dedup key for `observations[i]`; arrays must be the same
 * length. The caller computes keys exactly once during validation, which
 * guarantees that a non-deterministic `observationKey` cannot crash the
 * detector by throwing on a second invocation.
 */
function dedupePerAgentByKey(
  observations: readonly UsagePurposeObservation[],
  keys: readonly string[],
): readonly UsagePurposeObservation[] {
  // Nested-Map representation — `seen` is keyed by `agentId` so an agent's
  // dedup keys are isolated from any other agent's. A flat
  // `${agentId}|${key}` would collide when agentId or key contain the
  // delimiter.
  const seen = new Map<string, Set<string>>();
  const out: UsagePurposeObservation[] = [];
  for (let i = 0; i < observations.length; i++) {
    const o = observations[i];
    const key = keys[i];
    if (o === undefined || key === undefined) continue;
    let bucket = seen.get(o.agentId);
    if (bucket === undefined) {
      bucket = new Set<string>();
      seen.set(o.agentId, bucket);
    }
    if (bucket.has(key)) continue;
    bucket.add(key);
    out.push(o);
  }
  return out;
}

interface DivergentCohort {
  /** Number of agents whose own drift evidence cleared the bar. */
  readonly agentCount: number;
  /** Total observations attributed to those agents. */
  readonly observationCount: number;
  /** Sum of divergence scores across those observations. */
  readonly totalDivergence: number;
}

/**
 * Identify the cohort of agents whose *own* drift evidence clears the bar:
 * an agent contributes when they have at least `minObservationsPerAgent`
 * observations whose `divergenceScore ≥ divergenceThreshold`. Only those
 * qualifying observations enter the cohort totals — baseline samples from
 * the same agent stay out.
 *
 * Earlier versions averaged every observation for an agent then included
 * all-or-none, so an agent who mixed baseline and repurposed traffic could
 * never clear their personal average and their drift evidence was dropped.
 * Per-observation qualification fixes that without lowering the bar:
 * a single high-divergence sample still isn't enough (the per-agent floor
 * holds), but real drift mixed with baseline now surfaces.
 */
function computeDivergentCohort(
  observations: readonly UsagePurposeObservation[],
  thresholds: ExaptationThresholds,
): DivergentCohort {
  const divergentSums = new Map<string, number>();
  const divergentCounts = new Map<string, number>();
  for (const o of observations) {
    if (o.divergenceScore < thresholds.divergenceThreshold) continue;
    divergentSums.set(o.agentId, (divergentSums.get(o.agentId) ?? 0) + o.divergenceScore);
    divergentCounts.set(o.agentId, (divergentCounts.get(o.agentId) ?? 0) + 1);
  }

  // let: cohort accumulators
  let agentCount = 0;
  let observationCount = 0;
  let totalDivergence = 0;
  for (const [agentId, count] of divergentCounts) {
    if (count < thresholds.minObservationsPerAgent) continue;
    agentCount++;
    observationCount += count;
    totalDivergence += divergentSums.get(agentId) ?? 0;
  }
  return { agentCount, observationCount, totalDivergence };
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
