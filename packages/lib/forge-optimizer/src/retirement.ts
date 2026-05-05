/**
 * Retirement policy — advisory only.
 *
 * Returns suggestions; never mutates the store. Only `active` bricks are
 * candidates: retirement is the move out of `active`, so already-deprecated
 * or quarantined bricks are skipped.
 */

import type { BrickArtifact, BrickFitnessMetrics, BrickId } from "@koi/core";

export interface RetirementPolicy {
  /** Below this usage count, the brick is flagged. */
  readonly minUsageCount: number;
  /** Idle longer than this (ms since lastUsedAt) → flagged. */
  readonly maxIdleMs: number;
  /** Optional success-rate floor; only evaluated when sample size ≥ minSampleSize. */
  readonly minSuccessRate?: number;
  /** Minimum sample size before success-rate is trusted. Default: 10. */
  readonly minSampleSize?: number;
}

/**
 * Discriminates between an actual retirement recommendation and a
 * data-integrity finding. Callers that auto-apply retirement advice MUST
 * gate on `kind === "retire"`; integrity findings should be routed to an
 * operator dashboard, not into a bulk lifecycle apply.
 */
export interface RetirementSuggestion {
  readonly kind: "retire" | "integrity";
  readonly brickId: BrickId;
  readonly reason: string;
}

const DEFAULT_MIN_SAMPLE_SIZE = 10;

/**
 * Maximum tolerated forward clock skew between producer and consumer.
 * Real-world distributed clocks drift by seconds, occasionally minutes;
 * anything beyond this is almost certainly corruption (wrong unit, wrong
 * epoch, sign flip). Treating a far-future timestamp as `idle = 0` would
 * convert telemetry corruption into the strongest possible freshness
 * signal and silently suppress idle retirement on a stale brick.
 */
const MAX_FORWARD_SKEW_MS = 5 * 60 * 1000;

/**
 * Effective invocation count: prefer the runtime fitness totals when present,
 * fall back to the (possibly stale) `usageCount` field. The feedback-loop
 * telemetry path persists `fitness` but not `usageCount`, so a brick with
 * real traffic can carry a stale zero `usageCount`. Trust whichever signal
 * is larger.
 */
function safeNonNegativeInt(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function isFitnessObject(value: unknown): value is BrickFitnessMetrics {
  return value !== null && typeof value === "object";
}

function effectiveUsageCount(brick: BrickArtifact): number {
  const fitness = brick.fitness;
  // Defensive: fitness is optional and not structurally validated at load
  // boundaries. A malformed / null / wrong-typed record must not pull the
  // comparison into NaN OR throw on property access — silently un-flagging
  // low-usage bricks and crashing the entire batch sweep, respectively.
  const fitnessTotal = isFitnessObject(fitness)
    ? safeNonNegativeInt(fitness.successCount) + safeNonNegativeInt(fitness.errorCount)
    : 0;
  return Math.max(safeNonNegativeInt(brick.usageCount), fitnessTotal);
}

function isCorruptCounter(value: number): boolean {
  // Persisted counters must be finite non-negative integers. Fractional
  // values (e.g. 4.5) come from partial writes / deserialization bugs;
  // trusting them lets corruption drive retirement.
  return !Number.isFinite(value) || value < 0 || !Number.isInteger(value);
}

function evaluateBrick(
  brick: BrickArtifact,
  policy: RetirementPolicy,
  now: number,
): RetirementSuggestion | undefined {
  // Counter-integrity gate FIRST — before any retirement decision.
  // `usageCount` and fitness counters are both persisted telemetry; either
  // being corrupt (NaN/Infinity/negative) means we cannot evaluate
  // retirement honestly. `safeNonNegativeInt` would silently collapse
  // them to 0 and auto-retire a healthy active brick. Surface integrity
  // instead so observability failures cannot trigger lifecycle action.
  if (isCorruptCounter(brick.usageCount)) {
    return {
      kind: "integrity",
      brickId: brick.id,
      reason: `corrupt usageCount (${String(brick.usageCount)}); cannot evaluate retirement — integrity finding, do not auto-retire`,
    };
  }
  const fitnessForIntegrity = brick.fitness;
  // Wrong-typed top-level fitness (null, primitive, array) — partial
  // write or malformed deserialization. Treat as integrity, not as a
  // chance to crash the whole sweep on the first property access.
  if (fitnessForIntegrity !== undefined && !isFitnessObject(fitnessForIntegrity)) {
    return {
      kind: "integrity",
      brickId: brick.id,
      reason: `fitness is not an object (${String(fitnessForIntegrity)}); cannot evaluate retirement — integrity finding, do not auto-retire`,
    };
  }
  if (fitnessForIntegrity !== undefined) {
    if (
      isCorruptCounter(fitnessForIntegrity.successCount) ||
      isCorruptCounter(fitnessForIntegrity.errorCount)
    ) {
      return {
        kind: "integrity",
        brickId: brick.id,
        reason: `corrupt success/error counters (success=${String(fitnessForIntegrity.successCount)}, error=${String(fitnessForIntegrity.errorCount)}); cannot evaluate retirement — integrity finding, do not auto-retire`,
      };
    }
    // Run lastUsedAt integrity BEFORE the low-usage retirement gate.
    // A brick with corrupt recency must never auto-retire on the
    // low-usage path either — observability failure ≠ idleness.
    const tsCheck = fitnessForIntegrity.lastUsedAt;
    if (!Number.isFinite(tsCheck) || tsCheck < 0) {
      return {
        kind: "integrity",
        brickId: brick.id,
        reason: `corrupt lastUsedAt (${String(tsCheck)}); cannot verify recency — integrity finding, do not auto-retire`,
      };
    }
    if (tsCheck - now > MAX_FORWARD_SKEW_MS) {
      return {
        kind: "integrity",
        brickId: brick.id,
        reason: `lastUsedAt (${String(tsCheck)}) is ${String(tsCheck - now)}ms beyond now (> ${String(MAX_FORWARD_SKEW_MS)}ms); cannot verify recency — integrity finding, do not auto-retire`,
      };
    }
  }
  const usage = effectiveUsageCount(brick);
  if (usage < policy.minUsageCount) {
    // When fitness telemetry is missing, `effectiveUsageCount` falls back
    // to `usageCount` alone. The runtime telemetry path (middleware-
    // feedback-loop) updates fitness but not usageCount, so an active
    // brick with missing fitness can carry a stale low usageCount that
    // would auto-retire it. Treat this as integrity, not idleness.
    if (brick.fitness === undefined) {
      return {
        kind: "integrity",
        brickId: brick.id,
        reason: `low usageCount (${String(usage)}) but no fitness telemetry to corroborate; cannot evaluate retirement — integrity finding, do not auto-retire`,
      };
    }
    return {
      kind: "retire",
      brickId: brick.id,
      reason: `usage count ${String(usage)} < min ${String(policy.minUsageCount)}`,
    };
  }
  const fitness = brick.fitness;
  if (fitness === undefined) {
    // Missing telemetry on an active brick that has cleared the usage
    // gate — schema migration, partial write, or telemetry outage. Surface
    // as an explicit integrity finding so callers can drive repair, but
    // do NOT retire (observability failure ≠ idleness).
    return {
      kind: "integrity",
      brickId: brick.id,
      reason:
        "missing fitness telemetry on active brick; cannot evaluate recency or success rate — integrity finding, do not auto-retire",
    };
  }
  // `lastUsedAt` integrity (non-finite, negative, far-future) was already
  // gated upfront so a corrupt timestamp cannot reach the low-usage
  // retirement path. Here we only need the bounded clock-skew clamp for
  // small forward drift.
  const ts = fitness.lastUsedAt;
  const lastUsedAt = ts > now ? now : ts;
  const idleMs = now - lastUsedAt;
  if (idleMs > policy.maxIdleMs) {
    return {
      kind: "retire",
      brickId: brick.id,
      reason: `idle for ${String(idleMs)}ms (> ${String(policy.maxIdleMs)}ms)`,
    };
  }
  return checkSuccessRate(brick, policy, fitness);
}

function checkSuccessRate(
  brick: BrickArtifact,
  policy: RetirementPolicy,
  fitness: BrickFitnessMetrics | undefined,
): RetirementSuggestion | undefined {
  if (policy.minSuccessRate === undefined || fitness === undefined) return undefined;
  // Counter integrity is gated upstream in `evaluateBrick`; if we got
  // here, both counters are finite non-negative integers.
  const total = fitness.successCount + fitness.errorCount;
  const minSamples = policy.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;
  if (total < minSamples) return undefined;
  // Even if `minSampleSize === 0` is configured, total === 0 yields a
  // NaN rate that fails the `rate >= minSuccessRate` check and would
  // produce a false retirement suggestion. Require at least one sample
  // before computing a success rate.
  if (total === 0) return undefined;
  const rate = fitness.successCount / total;
  if (rate >= policy.minSuccessRate) return undefined;
  return {
    kind: "retire",
    brickId: brick.id,
    reason: `success rate ${rate.toFixed(2)} < min ${policy.minSuccessRate.toFixed(2)} (${String(total)} samples)`,
  };
}

/**
 * Reject a malformed policy at the API boundary. A `NaN` threshold or
 * negative `maxIdleMs` would produce mass-incorrect lifecycle suggestions
 * downstream (NaN comparisons silently false; negative idle flags every
 * brick); fail loudly instead of poisoning the output.
 */
function validatePolicy(policy: RetirementPolicy): void {
  if (
    !Number.isFinite(policy.minUsageCount) ||
    policy.minUsageCount < 0 ||
    !Number.isInteger(policy.minUsageCount)
  ) {
    throw new TypeError(
      `RetirementPolicy.minUsageCount must be a finite non-negative integer; got ${String(policy.minUsageCount)}`,
    );
  }
  if (!Number.isFinite(policy.maxIdleMs) || policy.maxIdleMs < 0) {
    throw new TypeError(
      `RetirementPolicy.maxIdleMs must be a finite non-negative number; got ${String(policy.maxIdleMs)}`,
    );
  }
  if (policy.minSuccessRate !== undefined) {
    if (
      !Number.isFinite(policy.minSuccessRate) ||
      policy.minSuccessRate < 0 ||
      policy.minSuccessRate > 1
    ) {
      throw new TypeError(
        `RetirementPolicy.minSuccessRate must be in [0, 1]; got ${String(policy.minSuccessRate)}`,
      );
    }
  }
  if (policy.minSampleSize !== undefined) {
    if (
      !Number.isFinite(policy.minSampleSize) ||
      policy.minSampleSize < 0 ||
      !Number.isInteger(policy.minSampleSize)
    ) {
      throw new TypeError(
        `RetirementPolicy.minSampleSize must be a finite non-negative integer; got ${String(policy.minSampleSize)}`,
      );
    }
  }
}

export function suggestRetirement(
  bricks: readonly BrickArtifact[],
  policy: RetirementPolicy,
  now: number = Date.now(),
): readonly RetirementSuggestion[] {
  validatePolicy(policy);
  // Reject non-finite `now`. A `NaN`/`Infinity` clock would make `idleMs >
  // maxIdleMs` always false, silently disabling idle retirement for every
  // brick — fail loudly so a bad clock or JS caller bug surfaces.
  if (!Number.isFinite(now)) {
    throw new TypeError(`suggestRetirement requires finite \`now\`; got ${String(now)}`);
  }
  const out: RetirementSuggestion[] = [];
  for (const brick of bricks) {
    if (brick.lifecycle !== "active") continue;
    const suggestion = evaluateBrick(brick, policy, now);
    if (suggestion !== undefined) out.push(suggestion);
  }
  return out;
}
