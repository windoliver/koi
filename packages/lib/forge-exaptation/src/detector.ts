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
}

/**
 * Replay protection is a **per-observation data contract**, not a config knob.
 *
 * The detector marks a window `replayProtected: true` when every valid
 * observation carries a non-empty string `eventId` (e.g. an upstream
 * correlation ID, idempotency key, or monotonic sequence number) — and uses
 * that ID, scoped per-agent, as the dedup key. If even one observation lacks
 * `eventId`, the window is `replayProtected: false`, no dedup runs, and
 * `suggestAction` refuses to recommend `reclassify` or `new-artifact`.
 *
 * No honor-system boolean. No caller-supplied key function whose stability
 * the detector can't verify. The presence of `eventId` on every sample is
 * the contract, and `isObservationValid` validates it.
 */

/** Sensible defaults — conservative to minimize false positives. */
export const DEFAULT_EXAPTATION_THRESHOLDS: ExaptationThresholds = {
  minObservations: 5,
  divergenceThreshold: 0.7,
  minDivergentAgents: 2,
  minObservationsPerAgent: 2,
  confidenceWeight: 0.8,
} as const;

/**
 * Internal brand stamped on every result that comes out of `detectDrift`.
 * `suggestAction` rejects inputs that lack this brand, so a caller cannot
 * fabricate a drift result with `replayProtected: true` and zero
 * dropped/duplicate counts to bypass the quality + replay-protection gates.
 *
 * The symbol is intentionally module-local — not exported, not in the
 * public `DetectionResult` type. External code has no name by which to
 * attach it, so structurally-reconstructed objects always fail the check.
 */
const DETECTION_BRAND = Symbol("forge-exaptation/DetectionResult");
type Branded<T> = T & { readonly [DETECTION_BRAND]: true };

function brand<T>(result: T): Branded<T> {
  return Object.freeze({ ...(result as object), [DETECTION_BRAND]: true }) as Branded<T>;
}

function isBranded(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { readonly [DETECTION_BRAND]?: unknown })[DETECTION_BRAND] === true
  );
}

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
      /** False when any valid observation lacks `eventId` — `suggestAction` will refuse. */
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
/**
 * Minimum cohort share of the full validated window required for a
 * `reclassify` suggestion. Reclassify rewrites the artifact's canonical
 * purpose, so the drifting cohort must represent a majority of traffic.
 * Below this share, only `new-artifact` (fork a specialized variant) is
 * allowed — minority drift should branch off, not overwrite the canonical
 * description that the still-baseline majority depends on.
 */
const RECLASSIFY_MIN_COHORT_SHARE = 0.5;

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
    return brand({ kind: "invalid-config", reason: configError });
  }

  // Validate observations. agentId + divergenceScore are required for any
  // scoring path. eventId is OPTIONAL data — its presence on every valid
  // sample is what unlocks replay protection downstream.
  const valid: UsagePurposeObservation[] = [];
  for (const o of observations) {
    if (!isObservationValid(o)) continue;
    valid.push(o);
  }
  const droppedCount = observations.length - valid.length;

  // Replay protection is a per-observation data contract: every valid
  // observation must carry a non-empty string `eventId`. Even one missing
  // or empty eventId disables replay protection for the whole window —
  // we cannot know whether the missing samples were retried duplicates.
  const allHaveEventId = valid.every((o) => typeof o.eventId === "string" && o.eventId.length > 0);
  const replayProtected = valid.length > 0 && allHaveEventId;

  // Dedup runs only when replay-protected — with eventId per agent as the
  // dedup key. Without a stable per-event identity we cannot honestly
  // collapse duplicates without risking discarding distinct events.
  const unique = replayProtected ? dedupePerAgentByEventId(valid) : valid;
  const duplicateCount = valid.length - unique.length;

  const noDrift = (): DetectionResult =>
    brand({
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

  return brand({
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
  });
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
  // Authenticity gate. The internal brand is unreachable from outside this
  // module, so any input that wasn't returned by `detectDrift` (e.g. a
  // structurally-reconstructed object intended to bypass the quality and
  // replay-protection gates) is rejected here.
  if (!isBranded(input)) return { kind: "none" };
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
  const stableAndStrong =
    stableWindows >= STABLE_WINDOW_COUNT &&
    report.avgDivergence >= NEW_ARTIFACT_DIVERGENCE_THRESHOLD;
  if (stableAndStrong) {
    return { kind: "new-artifact", severity: report.severity };
  }
  // Reclassify rewrites the canonical purpose — only safe when the drifting
  // cohort is a majority of validated traffic. A minority cohort that isn't
  // strong enough to fork should NOT overwrite the description that the
  // baseline majority still depends on; return `none` and wait for either
  // the cohort to grow or for stableWindows + divergence to qualify the
  // result for `new-artifact`.
  const cohortShare =
    input.validObservationCount > 0 ? report.observationCount / input.validObservationCount : 0;
  if (cohortShare < RECLASSIFY_MIN_COHORT_SHARE) return { kind: "none" };
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
 * Dedup observations per agent using each observation's `eventId`. Caller has
 * already verified that every input has a non-empty string `eventId`, so the
 * field reads here are safe. Dedup namespace is `(agentId, eventId)`, so
 * identical event IDs from different agents always survive.
 *
 * Conflict resolution is deterministic, content-based — NOT first-write-wins.
 * When the same `(agentId, eventId)` arrives more than once with different
 * payloads (a realistic outcome of retries-with-divergent-rescore), pick:
 *   1. the highest `divergenceScore`     — score conflict resolution
 *   2. then the highest `observedAt`     — order tiebreak (newest wins)
 *   3. then `contextText` lexicographic  — final deterministic tiebreak
 *
 * Outcome no longer depends on ingestion order, so retried events cannot
 * silently flip the drift decision based on which copy arrived first.
 */
function dedupePerAgentByEventId(
  observations: readonly UsagePurposeObservation[],
): readonly UsagePurposeObservation[] {
  const winners = new Map<string, Map<string, UsagePurposeObservation>>();
  for (const o of observations) {
    const eventId = o.eventId;
    if (eventId === undefined) continue;
    let bucket = winners.get(o.agentId);
    if (bucket === undefined) {
      bucket = new Map<string, UsagePurposeObservation>();
      winners.set(o.agentId, bucket);
    }
    const incumbent = bucket.get(eventId);
    if (incumbent === undefined || prefersChallenger(incumbent, o)) {
      bucket.set(eventId, o);
    }
  }
  // Preserve insertion-stable iteration so output is deterministic across
  // runs given the same input set.
  const out: UsagePurposeObservation[] = [];
  for (const bucket of winners.values()) for (const o of bucket.values()) out.push(o);
  return out;
}

function prefersChallenger(
  incumbent: UsagePurposeObservation,
  challenger: UsagePurposeObservation,
): boolean {
  if (challenger.divergenceScore !== incumbent.divergenceScore)
    return challenger.divergenceScore > incumbent.divergenceScore;
  if (challenger.observedAt !== incumbent.observedAt)
    return challenger.observedAt > incumbent.observedAt;
  return challenger.contextText > incumbent.contextText;
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
