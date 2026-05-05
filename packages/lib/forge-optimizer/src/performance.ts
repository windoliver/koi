/**
 * Performance scoring — pure function over `BrickFitnessMetrics`.
 *
 * score = successRate * (1 / max(1, p99LatencyMs)) * recencyFactor
 *   recencyFactor = 0.5 ^ (ageMs / evaluationWindowMs)
 *
 * Uses the P99 latency rather than the mean so a brick with rare-but-
 * severe slow requests cannot mask its slow tail behind fast samples.
 * Aligns with the canonical scorer in `@koi/validation/fitness-scoring.ts`
 * which calls `computePercentile(sampler, 0.99)`.
 *
 * All inputs are L0 types; no I/O.
 */

import type { BrickFitnessMetrics } from "@koi/core";

const DEFAULT_EVALUATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface PerformanceScoreOptions {
  /** Recency factor halves every window. Default: 7 days. */
  readonly evaluationWindowMs?: number;
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Returns the average of valid latency samples, or `undefined` to signal
 * "no usable data". Two distinct cases:
 *   - empty buffer (never used) → `undefined`; caller treats as 1ms baseline
 *   - non-empty buffer where every sample is invalid → `undefined`; caller
 *     suppresses the score so corrupted telemetry cannot outrank healthy
 *     bricks by being interpreted as perfect 1ms latency.
 */
/**
 * P99 latency from the sorted-ascending sampler buffer. Mirrors
 * `@koi/validation/computePercentile(sampler, 0.99)` so this package's
 * scoring agrees with the canonical fitness scorer in
 * `@koi/validation/fitness-scoring.ts` — using the mean instead would
 * mask rare-but-severe slow tails that violate user-visible latency
 * expectations under load.
 *
 * Returns `undefined` when no valid sample is available so the caller
 * fails closed instead of inventing a baseline.
 */
function p99ValidLatency(samples: readonly number[]): number | undefined {
  // Fail closed if ANY sample is invalid. A mixed-validity buffer
  // (e.g. [10, NaN, Infinity]) is partial-write / deserialization
  // corruption. Silently dropping the bad samples would let the brick
  // score on a curated subset and look artificially fast.
  for (const s of samples) {
    if (!isFiniteNonNegative(s)) return undefined;
  }
  if (samples.length === 0) return undefined;
  // L0 contract says samples are sorted ascending; re-sort defensively.
  const sorted = [...samples].sort((a, b) => a - b);
  // Same percentile formula as @koi/validation/computePercentile.
  const idx = Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length));
  const v = sorted[idx];
  if (v === undefined) return undefined;
  return Math.max(1, v);
}

/**
 * Non-negative, finite performance score. Fails closed:
 *
 * - Either invocation counter non-finite/negative → 0 (corrupted record;
 *   refuse to rank rather than upgrade partial corruption into a high
 *   success rate).
 * - `lastUsedAt` or `now` non-finite → 0 (malformed timestamps must not
 *   beat real ones; idle-retirement separately flags the same record).
 * - `evaluationWindowMs` non-finite or non-positive → fall back to default
 *   (config error, but still produce a useful number).
 *
 * Latency samples are filtered individually — a single bad sample does
 * not invalidate the rest of the buffer.
 */
export function computePerformanceScore(
  fitness: BrickFitnessMetrics,
  now: number,
  options: PerformanceScoreOptions = {},
): number {
  // Top-level fitness shape — null / primitive / array would throw on
  // the first property access and break the advertised "does not throw
  // on bad batch input" contract. Fail closed instead.
  if (fitness === null || typeof fitness !== "object") return 0;
  // Counters must be finite non-negative integers. Fractional values
  // come from partial writes / deserialization bugs and would let
  // corruption drive ranking — fail closed instead.
  if (
    !isFiniteNonNegative(fitness.successCount) ||
    !isFiniteNonNegative(fitness.errorCount) ||
    !Number.isInteger(fitness.successCount) ||
    !Number.isInteger(fitness.errorCount)
  ) {
    return 0;
  }
  if (!Number.isFinite(now) || !isFiniteNonNegative(fitness.lastUsedAt)) {
    return 0;
  }
  // Future `lastUsedAt` is clamped to `now` (elapsed = 0) — matches the
  // existing clamp pattern in @koi/validation/fitness-scoring.ts so a
  // small producer/consumer clock skew does not flip the score to 0.
  // The malformed-record case (non-finite/negative) is already rejected
  // above; this branch only sees finite, non-negative timestamps.
  const total = fitness.successCount + fitness.errorCount;
  if (total === 0) return 0;

  const successRate = fitness.successCount / total;
  // Latency-sampler invariant:
  //   - `count` must itself be a finite non-negative integer; NaN/Infinity/
  //     negative is a corrupt record and must fail closed.
  //   - if `count > 0` then `samples` must be non-empty (lost buffer is
  //     corruption and must not be ranked as a 1ms baseline).
  // Defensive sampler-shape check. A persisted record may arrive with
  // `latency` missing or wrong-typed (partial write, deserialized JSON).
  // Other entry points (`recordUsage`/`suggestRetirement`) defend; we
  // must too — otherwise an optimizer sweep crashes the whole batch on
  // one bad brick. Fail closed (return 0) instead.
  const latency = fitness.latency;
  if (latency === undefined || latency === null || typeof latency !== "object") return 0;
  const samples = Array.isArray(latency.samples) ? latency.samples : null;
  if (samples === null) return 0;
  const sampleCount = latency.count;
  if (typeof sampleCount !== "number") return 0;
  if (!isFiniteNonNegative(sampleCount) || !Number.isInteger(sampleCount)) return 0;
  if (sampleCount > 0 && samples.length === 0) return 0;
  if (sampleCount === 0 && samples.length > 0) return 0;
  // `count` must be at least `samples.length`; a smaller count is a
  // partial-write artifact (the sampler invariant guarantees count grows
  // monotonically and equals or exceeds buffer length).
  if (sampleCount < samples.length) return 0;
  // `cap` must be a finite integer >= 1. A zero / negative / non-integer
  // / NaN cap is corrupt; the same record could carry an oversized buffer
  // (samples.length > cap) which the rest of the package treats as
  // corruption and heals — scoring it would let bad telemetry rank
  // bricks. Fail closed.
  const cap = latency.cap;
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 1 || !Number.isInteger(cap)) {
    return 0;
  }
  if (samples.length > cap) return 0;
  // Counters say there were invocations but the latency buffer is empty:
  // partial telemetry / dropped sampler. Treating this as a 1ms baseline
  // would rank the brick at near-best latency despite no measurement —
  // outranking real fast bricks. Fail closed.
  if (total > 0 && samples.length === 0) return 0;
  // Non-empty but all-invalid → suppress the score: corrupted telemetry
  // must not be interpreted as perfect latency and outrank healthy bricks.
  const measured = p99ValidLatency(samples);
  if (measured === undefined) return 0;
  const p99Latency = measured;
  const requestedWindow = options.evaluationWindowMs ?? DEFAULT_EVALUATION_WINDOW_MS;
  const windowMs =
    Number.isFinite(requestedWindow) && requestedWindow > 0
      ? requestedWindow
      : DEFAULT_EVALUATION_WINDOW_MS;
  const ageMs = Math.max(0, now - fitness.lastUsedAt);
  const recencyFactor = 0.5 ** (ageMs / windowMs);

  const score = successRate * (1 / p99Latency) * recencyFactor;
  return Number.isFinite(score) && score >= 0 ? score : 0;
}
