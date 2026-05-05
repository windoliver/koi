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
       * Number of valid observations that lacked a usable `eventId` and so
       * bypassed dedup. These are NOT replay-checked, so the quality gate
       * counts them as low-quality evidence even when they sit outside the
       * cohort. Without this, partial telemetry outage would be invisible
       * to the gate as long as the cohort itself was clean.
       */
      readonly missingEventIdCount: number;
      /**
       * Total post-dedup valid observations in the window — including baseline
       * traffic outside the divergent cohort. Used by `suggestAction`'s quality
       * gate so that clean baseline-heavy windows aren't punished for the
       * cohort being a small slice.
       */
      readonly validObservationCount: number;
      /**
       * Window-wide replay protection: true iff EVERY valid observation in
       * the window carried `eventId`. Matches the L0 contract on
       * `UsagePurposeObservation.eventId`. Public consumers branching on
       * this field can rely on it as a whole-window signal.
       */
      readonly replayProtected: boolean;
      /**
       * Cohort-scoped replay protection: true iff every observation
       * contributing to the divergent cohort carried `eventId`. Used by
       * `suggestAction`'s action gate so a baseline sample missing
       * `eventId` outside the cohort does not veto action for an
       * otherwise replay-protected cohort.
       */
      readonly cohortReplayProtected: boolean;
      /**
       * True iff any cohort observation was normalized to `LEGACY_SCOPE`
       * (missing/blank `scope`). Such cohorts may merge multiple tenants
       * during a rolling migration, so `suggestAction` refuses to emit
       * `reclassify` / `new-artifact` when this is set — irreversible
       * actions must NOT be driven by potentially cross-tenant evidence.
       * The drift signal itself is still reported as observability data.
       */
      readonly cohortHasLegacyScope: boolean;
    }
  | {
      readonly kind: "no-drift";
      readonly observationCount: number;
      readonly validObservationCount: number;
      readonly droppedCount: number;
      readonly duplicateCount: number;
      readonly conflictCount: number;
      readonly missingEventIdCount: number;
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

  // Validate observations. agentId + divergenceScore are required;
  // scope is optional for backward compatibility and missing/blank values
  // are normalized to `LEGACY_SCOPE` (a named, observable sentinel — NOT
  // an implicit global namespace). eventId is OPTIONAL data — its presence
  // on every valid sample is what unlocks replay protection downstream.
  //
  // Normalize scope and agentId by trimming so all downstream bucketing
  // (dedup, cohort attribution) sees one canonical form. Without this,
  // "agent" and "agent " would bucket as two distinct agents, and
  // "tenant-A" and " tenant-A " would bucket as two distinct tenants.
  const valid: UsagePurposeObservation[] = [];
  for (const o of observations) {
    if (!isObservationValid(o)) continue;
    const normalizedScope = normalizeScope(o.scope);
    const trimmedAgent = o.agentId.trim();
    if (normalizedScope === o.scope && trimmedAgent === o.agentId) {
      valid.push(o);
    } else {
      valid.push({ ...o, scope: normalizedScope, agentId: trimmedAgent });
    }
  }
  const droppedCount = observations.length - valid.length;

  // Total telemetry loss: every observation dropped at validation. This is a
  // detector failure, not a healthy "no-drift" signal — surface it as
  // invalid-config so callers can branch into a degraded-input alarm path
  // instead of confusing it with absence of drift. Only triggers when input
  // was non-empty (caller actually had data to analyze).
  if (observations.length > 0 && valid.length === 0) {
    return deepFreeze({
      kind: "invalid-config" as const,
      reason: `all ${String(observations.length)} observations dropped at validation (degraded telemetry)`,
    });
  }

  // Single-artifact invariant: every valid observation in one window
  // must share an artifactId. The detector is per-artifact, and a
  // window mixing artifacts A and B would let evidence aggregate
  // across them — driving rewrites/forks for the wrong artifact. Fail
  // closed when the caller hands us a contaminated window.
  const distinctArtifactIds = new Set<string>();
  for (const v of valid) distinctArtifactIds.add(v.artifactId.trim());
  if (distinctArtifactIds.size > 1) {
    return deepFreeze({
      kind: "invalid-config" as const,
      reason: `window mixes ${String(distinctArtifactIds.size)} distinct artifactIds; detector is per-artifact`,
    });
  }

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
  const missingEventIdCount = withoutEventId.length;
  // Track which observations bypassed dedup (no eventId). Object identity
  // works because we never copy these references after partitioning.
  const noEventIdSet = new Set<UsagePurposeObservation>(withoutEventId);
  // Window-level replayProtected: every valid observation has eventId. Used
  // for the "no-drift" branch (no cohort to scope to) and as a coarse
  // telemetry signal.
  const windowReplayProtected = valid.length > 0 && missingEventIdCount === 0;

  const noDrift = (): DetectionResult =>
    deepFreeze({
      kind: "no-drift" as const,
      observationCount: unique.length,
      validObservationCount: unique.length,
      droppedCount,
      duplicateCount,
      conflictCount,
      missingEventIdCount,
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

  // Two replay-protection signals:
  //   - `replayProtected` (window-wide): public contract field, true iff
  //     every valid observation carried eventId. Matches the L0 docstring.
  //   - `cohortReplayProtected` (cohort-scoped): used by suggestAction's
  //     action gate so a baseline sample missing eventId outside the
  //     cohort does not veto action for an otherwise clean cohort. A
  //     downstream caller should NOT use `replayProtected` for the
  //     action decision — that's what `cohortReplayProtected` is for.
  return deepFreeze({
    kind: "drift" as const,
    droppedCount,
    duplicateCount,
    conflictCount,
    missingEventIdCount,
    validObservationCount: unique.length,
    replayProtected: windowReplayProtected,
    cohortReplayProtected: cohort.allCohortHadEventId,
    cohortHasLegacyScope: cohort.hasLegacyScope,
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
 * `priorWindows` may arrive in any order. Recency is derived from each
 * window's **maximum `observedAt`** across its valid observations — the
 * caller cannot manufacture stability by reordering the array. Windows
 * whose observations have no finite `observedAt` (degraded telemetry) are
 * treated as oldest and cannot satisfy the trailing-run requirement. The
 * current window is NOT included.
 *
 * Stability is the count of consecutive most-recent prior windows whose
 * own `detectDrift` produced `kind: "drift"`, `replayProtected: true`,
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
  // Action gate uses cohort-scoped replay protection: baseline samples
  // missing eventId outside the cohort do not veto action.
  if (!result.cohortReplayProtected) return { kind: "none" };
  // Refuse irreversible action when any cohort observation lives in
  // LEGACY_SCOPE (the missing-/blank-scope compat bucket). Different
  // tenants that have not yet been migrated to explicit scope all share
  // that bucket, so a cohort drawn from it can mix unrelated tenants.
  // The drift signal is still surfaced via `detectDrift` for telemetry —
  // only the action recommendation is suppressed until producers are
  // migrated off the sentinel.
  if (result.cohortHasLegacyScope) return { kind: "none" };

  const total =
    result.validObservationCount +
    result.droppedCount +
    result.duplicateCount +
    result.conflictCount;
  // Missing-eventId observations bypassed dedup, so they are low-quality
  // evidence even when they fall outside the cohort. Folding them into the
  // gate denominator means partial telemetry outage is visible to the gate
  // (instead of being hidden by cohort-scoped replay protection).
  const lowQuality =
    result.droppedCount + result.duplicateCount + result.conflictCount + result.missingEventIdCount;
  if (total > 0 && lowQuality / total > MAX_QUALITY_DEGRADATION_RATIO) {
    return { kind: "none" };
  }

  const report = result.report;
  const priorStrongDrift = countStrongDriftPriors(priorWindows, observations, thresholds);
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
 * Recency is derived from each window's **maximum `observedAt`** across its
 * valid observations, NOT from caller-supplied array position. A buggy or
 * malicious caller can no longer manufacture stability by reordering the
 * array — the timestamps in the observations themselves drive the order.
 * Windows whose observations carry no finite `observedAt` (degraded
 * telemetry) sort to the bottom and break the trailing run before they can
 * be counted.
 *
 * Each prior must clear the SAME bar that the current window has to clear
 * to be action-safe:
 *   - `kind: "drift"` AND `replayProtected: true`
 *   - `avgDivergence ≥ NEW_ARTIFACT_DIVERGENCE_THRESHOLD` (0.85)
 *   - quality-gate pass: (dropped + duplicate + conflict + missingEventId)
 *     / total ≤ 25%
 *
 * Without the quality gate on priors, one replay-heavy / conflict-heavy
 * prior window — evidence the detector itself would refuse to act on — could
 * still bump stability for a fresh strong window. Requiring priors to pass
 * the same gate closes that path.
 */
function countStrongDriftPriors(
  priorWindows: readonly (readonly UsagePurposeObservation[])[],
  current: readonly UsagePurposeObservation[],
  thresholds: ExaptationThresholds,
): number {
  // Reject any prior that is the SAME window as the current evaluation
  // target. The doc says priorWindows must exclude the current window;
  // this enforces it instead of trusting it. We dedupe by both array
  // identity (the typical sliding-window bookkeeping bug) AND by a
  // content signature over validated observations (catches the case
  // where the same data was cloned into a new array). Without this
  // check, an off-by-one in the caller's history maintenance would let
  // the current strong window count as its own prior and immediately
  // promote the verdict to `new-artifact` on the very first window.
  // Build the current window's per-observation identity set (excluding
  // observedAt) so any prior that overlaps even partially can be
  // rejected. Identity-only equality is too narrow — a caller that
  // clones the current window and shifts a few timestamps would still
  // share most observations, and any shared observation makes the prior
  // non-independent evidence. Treat ANY overlap as disqualifying.
  const currentIdentities = new Set<string>();
  // Also derive the current window's artifact identity set so priors
  // that came from a different artifact (caller routing bug, multi-
  // artifact buffer mixup) cannot be borrowed as historical evidence.
  // We collect every distinct artifactId across the current window's
  // valid observations — if downstream a window mixes artifacts that's
  // already a contract violation, but we still want to reject any prior
  // whose artifact is not part of the current window's artifact set.
  // Current window's artifactId — invariant: a valid current window has
  // exactly one (`detectDrift` rejects mixed-artifact windows as
  // invalid-config; we won't reach this code path for those). We still
  // collect-then-take-first so this stays robust if validation rules
  // ever loosen.
  // let: single-artifact id for current window
  let currentArtifactId: string | undefined;
  for (const o of current) {
    if (!isObservationValid(o)) continue;
    currentIdentities.add(observationIdentity(o));
    if (currentArtifactId === undefined) currentArtifactId = o.artifactId.trim();
  }
  if (currentArtifactId === undefined) return 0;
  const filteredPriors = priorWindows.filter((w) => {
    if (w === current) return false;
    // Each prior must be SINGLE-artifact AND match the current. A prior
    // whose validated observations span multiple artifacts is itself
    // contaminated and unsafe to use as historical evidence; a prior
    // bound to a different artifact is unrelated history.
    const priorArtifactIds = new Set<string>();
    for (const o of w) {
      if (!isObservationValid(o)) continue;
      if (currentIdentities.has(observationIdentity(o))) return false;
      priorArtifactIds.add(o.artifactId.trim());
    }
    if (priorArtifactIds.size !== 1) return false;
    return priorArtifactIds.has(currentArtifactId);
  });
  // Pair each window with its max observedAt drawn ONLY from observations
  // that pass the same validity check `detectDrift` applies AND that
  // survive same-key dedup (canonical replay collapses to MIN observedAt
  // per `(scope, agentId, eventId)` bucket). Computing recency from raw
  // observations would let two attacks slip through:
  //   1. an invalid sample (missing scope, malformed agentId) with a
  //      junk future timestamp could plant fake recency;
  //   2. a same-key replay with the same payload but a bumped
  //      `observedAt` would be ignored for scoring (correct) yet still
  //      raise `maxAt` and forge recency on a stale window (the bug).
  // Pulling recency from deduped winners closes both paths.
  const indexed = filteredPriors.map((window) => ({
    window,
    maxAt: windowMaxAtAfterDedup(window),
  }));
  // Undated priors fail stability outright. Skipping them silently would
  // hide a most-recent weak/low-quality window that should break the
  // trailing run — letting an older strong window unlock `new-artifact`
  // during degraded telemetry. The intent is "stable across recent
  // history"; if we can't ORDER history we don't know it's recent.
  if (indexed.some((e) => !Number.isFinite(e.maxAt))) return 0;
  // Stability requires priors strictly older than the current window. A
  // caller that mixes a newer or same-time window into priorWindows
  // (sliding-window bookkeeping bug, multi-buffer mixup) must NOT have
  // it count toward stability. Drop the current window's recency the
  // same way priors compute theirs (deduped) so the comparison is fair.
  // If the current window itself has no finite recency, the run cannot
  // be ordered — fail stability outright.
  const currentMaxAt = windowMaxAtAfterDedup(current);
  if (!Number.isFinite(currentMaxAt)) return 0;
  const olderIndexed = indexed.filter((e) => e.maxAt < currentMaxAt);
  // Group windows by maxAt and walk groups from newest to oldest. Within a
  // tied group, EVERY window must clear the strong-drift bar — otherwise
  // the whole tied group breaks the run. This removes caller-steerability
  // when multiple windows share a timestamp (coarsened-to-the-second
  // batches, same-frame producers): the verdict no longer depends on
  // array order, because any failing window in the trailing tie group
  // halts the count regardless of where it sits in the array.
  const groups = new Map<number, (typeof indexed)[number][]>();
  for (const entry of olderIndexed) {
    const list = groups.get(entry.maxAt);
    if (list === undefined) groups.set(entry.maxAt, [entry]);
    else list.push(entry);
  }
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => b - a); // desc

  // let: prior-window stability accumulator (trailing consecutive run)
  let strong = 0;
  for (const [, windowsAtThisRecency] of sortedGroups) {
    // let: per-tie-group accumulator — must add atomically (all-or-nothing).
    let groupContribution = 0;
    let groupOk = true;
    for (const entry of windowsAtThisRecency) {
      const r = detectDrift(entry.window, thresholds);
      if (r.kind !== "drift") {
        groupOk = false;
        break;
      }
      if (!r.cohortReplayProtected) {
        groupOk = false;
        break;
      }
      if (r.report.avgDivergence < NEW_ARTIFACT_DIVERGENCE_THRESHOLD) {
        groupOk = false;
        break;
      }
      const total = r.validObservationCount + r.droppedCount + r.duplicateCount + r.conflictCount;
      const lowQuality =
        r.droppedCount + r.duplicateCount + r.conflictCount + r.missingEventIdCount;
      if (total > 0 && lowQuality / total > MAX_QUALITY_DEGRADATION_RATIO) {
        groupOk = false;
        break;
      }
      // Legacy-scope contamination disqualifies a prior the same way it
      // disqualifies the current window — keep the bar consistent end-to-end.
      if (r.cohortHasLegacyScope) {
        groupOk = false;
        break;
      }
      groupContribution++;
    }
    if (!groupOk) break;
    strong += groupContribution;
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

/**
 * Sentinel namespace for observations whose `scope` is missing or blank.
 * Named on purpose so it shows up explicitly in cohort keys and dedup
 * buckets — callers can grep for it, alert on it, and migrate emitters
 * away from it. The sentinel is NOT a default tenant: any deployment with
 * more than one real tenant that lets traffic fall here will see those
 * tenants share a single bucket. The doc on `UsagePurposeObservation.scope`
 * states this contract.
 */
const LEGACY_SCOPE = "__legacy__";

function normalizeScope(scope: string | undefined): string {
  if (typeof scope !== "string") return LEGACY_SCOPE;
  const trimmed = scope.trim();
  return trimmed.length === 0 ? LEGACY_SCOPE : trimmed;
}

/**
 * Stable content signature of a window's validated observations. Used to
 * detect when a caller has accidentally included the current window in
 * `priorWindows` — typical sliding-window bookkeeping bug — so the same
 * data cannot count as its own prior. Built from canonical fields
 * (post-trim scope, post-trim agentId, eventId, rounded divergence,
 * observedAt) so a clone of the array still produces the same signature.
 * Sorted to be order-independent — `[a, b]` and `[b, a]` are the same window.
 */
/**
 * Compute a window's max `observedAt` from observations that survive the
 * same validation + same-key dedup that `detectDrift` applies. Used by
 * `countStrongDriftPriors` so a same-eventId replay with a bumped
 * `observedAt` cannot forge fresh recency on a stale window — we collapse
 * each `(scope, agentId, eventId)` bucket to its MIN observedAt
 * (canonical first occurrence), then take the MAX across buckets.
 *
 * Observations without `eventId` are each their own bucket — there is no
 * replay protection for them, so they keep their raw `observedAt`.
 *
 * Returns `Number.NEGATIVE_INFINITY` when no validated observation has a
 * finite `observedAt` (callers treat that as "undated").
 */
function windowMaxAtAfterDedup(window: readonly UsagePurposeObservation[]): number {
  const minByKey = new Map<string, number>();
  const noKeyTimes: number[] = [];
  for (const o of window) {
    if (!isObservationValid(o)) continue;
    if (!Number.isFinite(o.observedAt)) continue;
    const eid = typeof o.eventId === "string" ? o.eventId.trim() : "";
    if (eid.length === 0) {
      noKeyTimes.push(o.observedAt);
      continue;
    }
    const scope = normalizeScope(o.scope);
    const agent = o.agentId.trim();
    const key = `${String(scope.length)}:${scope}|${String(agent.length)}:${agent}|${eid}`;
    const prev = minByKey.get(key);
    if (prev === undefined || o.observedAt < prev) minByKey.set(key, o.observedAt);
  }
  // let: max accumulator across deduped buckets and no-eventId observations
  let maxAt = Number.NEGATIVE_INFINITY;
  for (const v of minByKey.values()) if (v > maxAt) maxAt = v;
  for (const v of noKeyTimes) if (v > maxAt) maxAt = v;
  return maxAt;
}

/**
 * Stable per-observation identity. Excludes `observedAt` deliberately —
 * a clone of the current window with the timestamps shifted is still
 * the same observation set and must not bypass the self-reference
 * check on its way through `priorWindows`. Includes the normalized
 * payload (rounded score, normalized contextText) plus the dedup key
 * so two replays of one event collapse to a single token.
 */
function observationIdentity(o: UsagePurposeObservation): string {
  const scope = normalizeScope(o.scope);
  const agent = o.agentId.trim();
  const eid = typeof o.eventId === "string" ? o.eventId.trim() : "";
  const score = Math.round(o.divergenceScore * PAYLOAD_SCORE_FACTOR);
  const ctx = normalizeContext(o.contextText);
  // Length-prefix each variable-width field so concatenation cannot
  // collide (e.g. scope="ab" + agent="c" vs scope="a" + agent="bc").
  return [
    `${String(scope.length)}:${scope}`,
    `${String(agent.length)}:${agent}`,
    `${String(eid.length)}:${eid}`,
    String(score),
    `${String(ctx.length)}:${ctx}`,
  ].join("|");
}

function isObservationValid(o: UsagePurposeObservation): boolean {
  if (!isUnitInterval(o.divergenceScore)) return false;
  // artifactId is required: the detector is per-artifact, and binding
  // artifact identity to the data shape is what lets `suggestAction`
  // reject priors whose artifactId does not match the current window.
  // Without this, a routing bug in the caller's history maintenance
  // could let unrelated history unlock irreversible actions for the
  // wrong artifact.
  if (typeof o.artifactId !== "string" || o.artifactId.trim().length === 0) return false;
  // scope is intentionally permissive: missing / blank values are mapped
  // to LEGACY_SCOPE so pre-multi-tenant emitters keep wire-compat. agentId
  // remains required — without an agent identity we cannot attribute
  // cohort membership, so a blank-but-present string from a degraded
  // serializer must still drop. Otherwise an unattributable source could
  // satisfy minDivergentAgents and unlock irreversible suggestions.
  if (o.scope !== undefined && typeof o.scope !== "string") return false;
  // Reserve the LEGACY_SCOPE sentinel: a real tenant whose chosen scope
  // happens to match `"__legacy__"` would otherwise be merged with every
  // missing-scope emitter into the same bucket, defeating tenant
  // isolation in both replay dedup and cohort attribution. Reject the
  // explicit string at the boundary so the sentinel cannot be forged
  // from outside.
  if (typeof o.scope === "string" && o.scope.trim() === LEGACY_SCOPE) return false;
  if (typeof o.agentId !== "string" || o.agentId.trim().length === 0) return false;
  // contextText must be a string. Empty / whitespace is allowed (a tool with
  // no preceding model text is legitimate), but a non-string from an untyped
  // upstream payload would throw later inside `samePayload` when conflict
  // dedup tries to call `.trim()` on a duplicate-event bucket.
  if (typeof o.contextText !== "string") return false;
  return true;
}

/**
 * Composite `(scope, agentId)` key. Length-prefix prevents `a:b` / `ab:`
 * collisions. Accepts `scope` as `string | undefined` because L0 made the
 * field optional; missing/blank values are normalized to `LEGACY_SCOPE`
 * here so callers can hand observations through as-is.
 */
function scopeAgentKey(scope: string | undefined, agentId: string): string {
  const s = normalizeScope(scope);
  return `${String(s.length)}:${s}:${agentId}`;
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
 *   - `contextText` is fully whitespace-normalized: surrounding whitespace
 *     trimmed AND every internal run of whitespace collapsed to a single
 *     space. Rolling-deploy serializer changes (`"a b"` vs `"a  b"` vs
 *     `"a\tb"` vs `"a\nb"`) all compare equal.
 *
 * `isObservationValid` has already rejected non-finite scores and non-string
 * `contextText` upstream, so both inputs here are well-formed.
 *
 * Real conflicts — different rounded scores or genuinely different text —
 * still trigger quarantine, blocking corrupted-replay attacks.
 */
function samePayload(a: UsagePurposeObservation, b: UsagePurposeObservation): boolean {
  const sa = Math.round(a.divergenceScore * PAYLOAD_SCORE_FACTOR);
  const sb = Math.round(b.divergenceScore * PAYLOAD_SCORE_FACTOR);
  if (sa !== sb) return false;
  if (normalizeContext(a.contextText) !== normalizeContext(b.contextText)) return false;
  return true;
}

function normalizeContext(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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
  /**
   * True iff any agent contributing to the cohort lives in `LEGACY_SCOPE`.
   * Set so the suggestAction layer can refuse irreversible actions on
   * potentially cross-tenant evidence during a rolling scope migration.
   */
  readonly hasLegacyScope: boolean;
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
  // Per-agent: scope normalized at validation time. Used to detect cohort
  // members that fall into the LEGACY_SCOPE compat bucket so suggestAction
  // can refuse irreversible actions on potentially cross-tenant evidence.
  const agentScope = new Map<string, string>();
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
    if (!agentScope.has(key)) agentScope.set(key, normalizeScope(o.scope));
  }

  // let: cohort accumulators
  let agentCount = 0;
  let observationCount = 0;
  let totalDivergence = 0;
  let allCohortHadEventId = true;
  let hasLegacyScope = false;
  for (const [key, count] of divergentCounts) {
    if (count < thresholds.minObservationsPerAgent) continue;
    agentCount++;
    observationCount += count;
    totalDivergence += divergentSums.get(key) ?? 0;
    if (!(agentHadEventId.get(key) ?? false)) allCohortHadEventId = false;
    if (agentScope.get(key) === LEGACY_SCOPE) hasLegacyScope = true;
  }
  return { agentCount, observationCount, totalDivergence, allCohortHadEventId, hasLegacyScope };
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
