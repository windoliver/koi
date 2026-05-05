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
 * observation carries a non-empty string `eventId` — a deterministic
 * idempotency key derived from stable per-call identity (NOT a request-level
 * correlation ID, NOT an upstream causal event ID shared across agents,
 * NOT a freshly-minted nonce). See the L0 `UsagePurposeObservation.eventId`
 * docstring for the full contract; the requirement is identical here.
 *
 * Tenant isolation is enforced at runtime via the required `scope` field on
 * every observation. Dedup is keyed on `(scope, agentId, eventId)` and
 * cohort attribution on `(scope, agentId)`, so two tenants that share the
 * same logical `agentId` (or `eventId`) keep their evidence independent.
 * Observations missing or whitespace-only `scope` are dropped at validation
 * — there is no implicit "global" scope, exactly so a forgotten upstream
 * scope cannot silently merge tenants.
 *
 * If even one valid observation lacks `eventId` the window is
 * `replayProtected: false`, no dedup runs, and `suggestAction` refuses to
 * recommend `reclassify` or `new-artifact`. The contract is enforced by
 * `isObservationValid` at runtime.
 */

/** Sensible defaults — conservative to minimize false positives. */
export const DEFAULT_EXAPTATION_THRESHOLDS: ExaptationThresholds = {
  minObservations: 5,
  divergenceThreshold: 0.7,
  minDivergentAgents: 2,
  minObservationsPerAgent: 2,
  confidenceWeight: 0.8,
} as const;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
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
       * Number of observations quarantined because two retries on the same
       * `(scope, agentId, eventId)` arrived with non-identical payloads. The
       * detector treats such conflicts as low-quality evidence and refuses
       * to pick a "winner" — both samples are dropped from cohort scoring,
       * and the count is folded into `suggestAction`'s quality gate.
       */
      readonly conflictCount: number;
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
      readonly conflictCount: number;
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
    return deepFreeze({ kind: "invalid-config", reason: configError });
  }

  // Validate observations. scope + agentId + divergenceScore are required.
  // eventId is OPTIONAL data — its presence on every valid sample is what
  // unlocks replay protection downstream.
  //
  // Normalize scope and agentId by trimming so all downstream bucketing
  // (dedup, cohort attribution) sees one canonical form. Without this,
  // "agent" and "agent " would bucket as two distinct agents, and
  // "tenant-A" and " tenant-A " would bucket as two distinct tenants.
  const valid: UsagePurposeObservation[] = [];
  for (const o of observations) {
    if (!isObservationValid(o)) continue;
    const trimmedScope = o.scope.trim();
    const trimmedAgent = o.agentId.trim();
    if (trimmedScope === o.scope && trimmedAgent === o.agentId) {
      valid.push(o);
    } else {
      valid.push({ ...o, scope: trimmedScope, agentId: trimmedAgent });
    }
  }
  const droppedCount = observations.length - valid.length;

  // Partition by eventId presence. The replay-protectable subset is always
  // deduped — even when other samples in the window lack eventId — so a
  // partial telemetry failure cannot inflate evidence by passing through
  // replays of properly-IDed events. The non-protectable remainder bypasses
  // dedup (we can't honestly collapse what we can't identify) and drives
  // `replayProtected: false`, which keeps `suggestAction` conservative.
  const withEventId: UsagePurposeObservation[] = [];
  const withoutEventId: UsagePurposeObservation[] = [];
  for (const o of valid) {
    // Trim before checking: a whitespace-only string is upstream's way of
    // saying "field present but empty" (common JSON serialization quirk).
    // Treating " " or "\n" as a real ID would falsely flip replayProtected
    // on and collapse distinct observations into one whitespace bucket.
    if (typeof o.eventId === "string" && o.eventId.trim().length > 0) withEventId.push(o);
    else withoutEventId.push(o);
  }
  const dedup = dedupeByScopeAgentEvent(withEventId);
  const unique: readonly UsagePurposeObservation[] = [...dedup.winners, ...withoutEventId];
  const duplicateCount = dedup.duplicateCount;
  const conflictCount = dedup.conflictCount;
  // Track which observations bypassed dedup (no eventId). Object identity
  // works because we never copy these references after partitioning.
  const noEventIdSet = new Set<UsagePurposeObservation>(withoutEventId);
  // Window-level replayProtected: every valid observation has eventId. Used
  // for the "no-drift" branch (no cohort to scope to) and as a coarse
  // telemetry signal.
  const windowReplayProtected = valid.length > 0 && withoutEventId.length === 0;

  const noDrift = (): DetectionResult =>
    deepFreeze({
      kind: "no-drift" as const,
      observationCount: unique.length,
      validObservationCount: unique.length,
      droppedCount,
      duplicateCount,
      conflictCount,
      replayProtected: windowReplayProtected,
    });

  if (unique.length < thresholds.minObservations) return noDrift();

  // Identify the divergent cohort first, then score drift on *their*
  // observations only. The earlier "global avgDivergence ≥ threshold" gate
  // hid real drift whenever low-divergence baseline traffic dominated the
  // window — exactly the mixed-workload case this package must surface.
  const cohort = computeDivergentCohort(unique, thresholds, noEventIdSet);
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

  // Cohort-scoped replay protection: action-bearing decisions only need the
  // observations that drive the cohort to be replay-protected. A baseline
  // sample missing eventId in the same window is irrelevant to the verdict
  // and must NOT veto action for an otherwise clean cohort. Earlier rounds
  // gated on the whole window, which created an easy denial path: one bad
  // emitter could keep the detector permanently non-actionable.
  const replayProtected = cohort.allCohortHadEventId;

  return deepFreeze({
    kind: "drift" as const,
    droppedCount,
    duplicateCount,
    conflictCount,
    validObservationCount: unique.length,
    replayProtected,
    report: {
      kind: "purpose_drift" as const,
      severity,
      avgDivergence: cohortAvgDivergence,
      divergentAgents: cohort.agentCount,
      observationCount: cohort.observationCount,
    },
  });
}

/**
 * Recommend an action from raw observations. Internally re-runs `detectDrift`
 * on the current window AND on every prior window, so every input that drives
 * the verdict is observation-grounded:
 *
 *   - The current `DetectionResult` is recomputed from `observations`.
 *   - The "stability" signal that gates `new-artifact` is recomputed from
 *     `priorWindows` — NOT taken as a caller-supplied integer. Earlier
 *     rounds accepted `stableWindows: number`; a buggy caller, stale cache,
 *     or cross-artifact counter mixup could have unlocked irreversible
 *     `new-artifact` on the first strong drift window.
 *
 * `priorWindows` is ordered chronologically (oldest → most recent prior; does
 * NOT include the current window). Stability is the count of prior windows
 * whose own `detectDrift` produced `kind: "drift"`, `replayProtected: true`,
 * AND `avgDivergence ≥ NEW_ARTIFACT_DIVERGENCE_THRESHOLD`.
 *
 * Behaviour:
 *   - `none` when fresh detection is `no-drift`, `invalid-config`, or not
 *     replay-protected.
 *   - `none` when (`droppedCount + duplicateCount + conflictCount`) /
 *     (`validObservationCount + dropped + duplicate + conflict`) > 25%.
 *     Conflicts now count as low-quality so a corrupted-replay attack
 *     cannot bias the window past the threshold.
 *   - `new-artifact` when at least `STABLE_WINDOW_COUNT - 1` prior windows
 *     ALSO produced strong drift AND the current window's `avgDivergence ≥
 *     NEW_ARTIFACT_DIVERGENCE_THRESHOLD`. Gated on raw divergence and on
 *     observation-grounded stability.
 *   - `reclassify` when the divergent cohort is a majority of validated
 *     traffic; otherwise `none`.
 */
export function suggestAction(
  observations: readonly UsagePurposeObservation[],
  thresholds: ExaptationThresholds,
  priorWindows: readonly (readonly UsagePurposeObservation[])[] = [],
): ExaptationSuggestion {
  const result = detectDrift(observations, thresholds);
  if (result.kind !== "drift") return { kind: "none" };
  if (!result.replayProtected) return { kind: "none" };

  const total =
    result.validObservationCount +
    result.droppedCount +
    result.duplicateCount +
    result.conflictCount;
  const lowQuality = result.droppedCount + result.duplicateCount + result.conflictCount;
  if (total > 0 && lowQuality / total > MAX_QUALITY_DEGRADATION_RATIO) {
    return { kind: "none" };
  }

  const report = result.report;
  const priorStrongDrift = countStrongDriftPriors(priorWindows, thresholds);
  const stableAndStrong =
    priorStrongDrift >= STABLE_WINDOW_COUNT - 1 &&
    report.avgDivergence >= NEW_ARTIFACT_DIVERGENCE_THRESHOLD;
  if (stableAndStrong) {
    return { kind: "new-artifact", severity: report.severity };
  }
  const cohortShare =
    result.validObservationCount > 0 ? report.observationCount / result.validObservationCount : 0;
  if (cohortShare < RECLASSIFY_MIN_COHORT_SHARE) return { kind: "none" };
  return { kind: "reclassify", severity: report.severity };
}

/**
 * Count the **trailing consecutive run** of action-safe strong-drift prior
 * windows, walking from the most-recent prior backwards. Stops at the first
 * window that fails any criterion — so an old outlier far back in history
 * cannot satisfy stability for an unrelated current window.
 *
 * Each prior must clear the SAME bar that the current window has to clear
 * to be action-safe:
 *   - `kind: "drift"` AND `replayProtected: true`
 *   - `avgDivergence ≥ NEW_ARTIFACT_DIVERGENCE_THRESHOLD` (0.85)
 *   - quality-gate pass: (dropped + duplicate + conflict) / total ≤ 25%
 *
 * Without the quality gate on priors, one replay-heavy / conflict-heavy
 * prior window — evidence the detector itself would refuse to act on — could
 * still bump stability for a fresh strong window. Requiring priors to pass
 * the same gate closes that path.
 */
function countStrongDriftPriors(
  priorWindows: readonly (readonly UsagePurposeObservation[])[],
  thresholds: ExaptationThresholds,
): number {
  // let: prior-window stability accumulator (trailing consecutive run)
  let strong = 0;
  for (let i = priorWindows.length - 1; i >= 0; i--) {
    const window = priorWindows[i];
    if (window === undefined) break;
    const r = detectDrift(window, thresholds);
    if (r.kind !== "drift") break;
    if (!r.replayProtected) break;
    if (r.report.avgDivergence < NEW_ARTIFACT_DIVERGENCE_THRESHOLD) break;
    const total = r.validObservationCount + r.droppedCount + r.duplicateCount + r.conflictCount;
    const lowQuality = r.droppedCount + r.duplicateCount + r.conflictCount;
    if (total > 0 && lowQuality / total > MAX_QUALITY_DEGRADATION_RATIO) break;
    strong++;
  }
  return strong;
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
  // Trim agentId / scope before checking emptiness, the same way eventId is
  // handled. A blank-but-present string from a degraded serializer must not
  // count as a real identity — otherwise an unattributable source could
  // satisfy minDivergentAgents and unlock irreversible suggestions, or merge
  // into an implicit "global" tenant scope (the silent-merge failure mode
  // the required-`scope` contract exists to prevent).
  if (typeof o.scope !== "string" || o.scope.trim().length === 0) return false;
  if (typeof o.agentId !== "string" || o.agentId.trim().length === 0) return false;
  return true;
}

/** Composite `(scope, agentId)` key. Length-prefix prevents `a:b` / `ab:` collisions. */
function scopeAgentKey(scope: string, agentId: string): string {
  return `${String(scope.length)}:${scope}:${agentId}`;
}

interface DedupOutcome {
  /** Observations that survived dedup (one per `(scope, agentId, eventId)` bucket). */
  readonly winners: readonly UsagePurposeObservation[];
  /** Observations dropped as identical-payload retries (replay protection). */
  readonly duplicateCount: number;
  /** Observations dropped from quarantined conflict buckets (suspect retries). */
  readonly conflictCount: number;
}

/**
 * Dedup observations using `(scope, agentId, eventId)`. Caller has already
 * verified that every input has non-empty `scope`, `agentId`, and `eventId`.
 *
 * The L0 contract for `eventId` requires it to be a **per-observation**
 * idempotency key (NOT a shared upstream correlation ID), so:
 *
 *   - Retries of the same observation re-emit the same `eventId` and
 *     collapse here as duplicates (the desired replay protection).
 *   - Distinct tool calls within a request, multiple agents recording the
 *     same upstream causal event, and independent observations from
 *     different tenants all generate DIFFERENT `eventId`s and survive.
 *
 * Scope keeps tenants isolated at runtime: two tenants happening to mint the
 * same `(agentId, eventId)` pair stay in separate buckets because their
 * `scope` differs.
 *
 * Conflict handling: when two retries on the same key carry **different**
 * payloads (`divergenceScore` or `contextText` mismatch), the detector
 * refuses to pick a winner. Earlier rounds chose max-divergence + observedAt
 * + contextText for "deterministic" resolution, but that systematically
 * biases the system toward the most alarming sample — one corrupted replay
 * could push a benign observation into drift territory. Now the entire
 * bucket is quarantined: every observation that touched it is counted in
 * `conflictCount`, none flow through to cohort scoring, and the quality
 * gate folds the count into its low-quality denominator. Identical
 * payloads still collapse normally as duplicates.
 */
function dedupeByScopeAgentEvent(observations: readonly UsagePurposeObservation[]): DedupOutcome {
  // Outer key: scopeAgentKey(scope, agentId). Inner key: eventId.
  // Each leaf: list of all observations seen for that key (may grow when
  // payloads conflict — that's what triggers quarantine below).
  const buckets = new Map<string, Map<string, UsagePurposeObservation[]>>();
  for (const o of observations) {
    if (typeof o.eventId !== "string") continue;
    const eventId = o.eventId.trim();
    if (eventId.length === 0) continue;
    const key = scopeAgentKey(o.scope, o.agentId);
    let inner = buckets.get(key);
    if (inner === undefined) {
      inner = new Map<string, UsagePurposeObservation[]>();
      buckets.set(key, inner);
    }
    const list = inner.get(eventId);
    if (list === undefined) inner.set(eventId, [o]);
    else list.push(o);
  }

  const winners: UsagePurposeObservation[] = [];
  let duplicateCount = 0;
  let conflictCount = 0;
  for (const inner of buckets.values()) {
    for (const list of inner.values()) {
      if (list.length === 1) {
        const only = list[0];
        if (only !== undefined) winners.push(only);
        continue;
      }
      const head = list[0];
      if (head === undefined) continue;
      // Conflict iff any pair has non-identical (divergenceScore, contextText).
      // observedAt is descriptive metadata, not part of the conflict check.
      const consistent = list.every((o) => samePayload(o, head));
      if (consistent) {
        // True replay: keep one canonical sample (head), count the rest as duplicates.
        winners.push(head);
        duplicateCount += list.length - 1;
      } else {
        // Quarantine the whole bucket — including the seed observation.
        conflictCount += list.length;
      }
    }
  }
  return { winners, duplicateCount, conflictCount };
}

/**
 * Conflict-equivalence check for replay dedup. Compares **normalized** payloads
 * so harmless retry / version skew is not mistaken for a real conflict:
 *
 *   - `divergenceScore` is rounded to `PAYLOAD_SCORE_PRECISION` decimals;
 *     0.949999... compares equal to 0.95.
 *   - `contextText` is trimmed; rolling-deploy whitespace edits don't quarantine.
 *
 * `isObservationValid` has already rejected non-finite scores upstream, so
 * both inputs here are finite numbers in `[0, 1]` and exact rounding works.
 *
 * Real conflicts — different rounded scores or different trimmed text —
 * still trigger quarantine, blocking corrupted-replay attacks.
 */
function samePayload(a: UsagePurposeObservation, b: UsagePurposeObservation): boolean {
  const sa = Math.round(a.divergenceScore * PAYLOAD_SCORE_FACTOR);
  const sb = Math.round(b.divergenceScore * PAYLOAD_SCORE_FACTOR);
  if (sa !== sb) return false;
  if (a.contextText.trim() !== b.contextText.trim()) return false;
  return true;
}

const PAYLOAD_SCORE_PRECISION = 4;
const PAYLOAD_SCORE_FACTOR = 10 ** PAYLOAD_SCORE_PRECISION;

interface DivergentCohort {
  /** Number of agents whose own drift evidence cleared the bar. */
  readonly agentCount: number;
  /** Total observations attributed to those agents. */
  readonly observationCount: number;
  /** Sum of divergence scores across those observations. */
  readonly totalDivergence: number;
  /**
   * True iff every observation contributing to the cohort carried `eventId`
   * (i.e. went through dedup). Cohort-scoped replay protection: a baseline
   * sample missing eventId outside the cohort does NOT flip this to false.
   */
  readonly allCohortHadEventId: boolean;
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
  noEventIdSet: ReadonlySet<UsagePurposeObservation>,
): DivergentCohort {
  const divergentSums = new Map<string, number>();
  const divergentCounts = new Map<string, number>();
  // Per-agent: true while every divergent observation seen so far had eventId.
  const agentHadEventId = new Map<string, boolean>();
  for (const o of observations) {
    if (o.divergenceScore < thresholds.divergenceThreshold) continue;
    // Cohort attribution keys on `(scope, agentId)` — the same logical
    // agent in two tenants is two independent observers, so they each
    // count toward `minDivergentAgents`. Within one scope, an agent's
    // observations aggregate as one cohort member.
    const key = scopeAgentKey(o.scope, o.agentId);
    divergentSums.set(key, (divergentSums.get(key) ?? 0) + o.divergenceScore);
    divergentCounts.set(key, (divergentCounts.get(key) ?? 0) + 1);
    const hadEid = !noEventIdSet.has(o);
    agentHadEventId.set(key, (agentHadEventId.get(key) ?? true) && hadEid);
  }

  // let: cohort accumulators
  let agentCount = 0;
  let observationCount = 0;
  let totalDivergence = 0;
  let allCohortHadEventId = true;
  for (const [key, count] of divergentCounts) {
    if (count < thresholds.minObservationsPerAgent) continue;
    agentCount++;
    observationCount += count;
    totalDivergence += divergentSums.get(key) ?? 0;
    if (!(agentHadEventId.get(key) ?? false)) allCohortHadEventId = false;
  }
  return { agentCount, observationCount, totalDivergence, allCohortHadEventId };
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
