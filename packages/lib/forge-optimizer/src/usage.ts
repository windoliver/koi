/**
 * Usage tracking — pure updates of `BrickFitnessMetrics`.
 *
 * No I/O. No mutation. Callers persist the returned value via their store.
 */

import type { BrickFitnessMetrics, LatencySampler } from "@koi/core";

/**
 * Binary-search ascending-sorted insert. Returns a new array.
 */
function sortedInsert(arr: readonly number[], value: number): number[] {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midVal = arr[mid];
    if (midVal !== undefined && midVal < value) lo = mid + 1;
    else hi = mid;
  }
  return [...arr.slice(0, lo), value, ...arr.slice(lo)];
}

/**
 * mulberry32 — deterministic, well-distributed PRNG seeded from a single
 * 32-bit integer. Lets us compute reservoir-sampling decisions without
 * `Math.random()`, so replaying the same `(prior fitness, event)` pair
 * always yields the same buffer (replay-safe).
 */
function mulberry32(seed: number): number {
  let t = (seed | 0) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Deterministic, sorted, bounded latency-buffer update.
 *
 * `recordUsage` must be a pure, replay-safe state transition: replaying
 * the same event against the same prior fitness MUST yield the same
 * result, so we cannot use `Math.random()` here.
 *
 * Algorithm — deterministic reservoir sampling (Vitter Algorithm R) keyed
 * on `count`:
 *   - Below cap: sortedInsert the new sample.
 *   - At/above cap: with deterministic probability `cap / newCount`,
 *     replace one of the existing slots (chosen by deterministic hash);
 *     otherwise discard the new sample. Replacement preserves sorted
 *     order. As `count → ∞` the retained sample converges to a uniform
 *     reservoir over all observed latencies — representative, not biased
 *     toward extremes — while remaining identical across replays of the
 *     same event sequence.
 *   - Defensively sorts a legacy unsorted input before any binary search.
 */
/**
 * Returns true when the buffer is ascending-sorted AND every sample is
 * a finite non-negative number. NaN comparisons are always false, so a
 * `NaN`-containing buffer slips past a pure inversion check; we must
 * also sanitise/sort when a non-finite sample is present.
 */
function isCleanSorted(samples: readonly number[]): boolean {
  let prev = -Infinity;
  for (const s of samples) {
    if (!Number.isFinite(s) || s < 0) return false;
    if (s < prev) return false;
    prev = s;
  }
  return true;
}

function sanitiseAndSort(samples: readonly number[]): number[] {
  const cleaned: number[] = [];
  for (const s of samples) {
    if (Number.isFinite(s) && s >= 0) cleaned.push(s);
  }
  cleaned.sort((a, b) => a - b);
  return cleaned;
}

/**
 * Clamp a persisted `cap` to a finite integer >= 1. Legacy/corrupt records
 * may carry `0`, negatives, or `NaN`; running reservoir math against those
 * yields NaN victim indices and unbounded growth.
 */
function normaliseCap(cap: number): number {
  if (!Number.isFinite(cap) || cap < 1) return 1;
  return Math.max(1, Math.round(cap));
}

/**
 * Uniform downsample of a sorted ascending buffer to exactly `cap` items.
 * `slice(0, cap)` would keep only the fastest samples and bias future
 * scoring upward — discarding the slow tail makes the brick look much
 * faster than it actually was. Stride sampling preserves a representative
 * subset across the full latency distribution.
 */
function downsampleSortedToCap(sorted: readonly number[], cap: number): number[] {
  const n = sorted.length;
  if (n <= cap) return [...sorted];
  // Special-case cap=1: the stride formula collapses to index 0 (the
  // minimum), which biases scoring toward best-case latency. Use the
  // median instead so the surviving sample reflects central tendency,
  // not the fastest observation.
  if (cap === 1) {
    const median = sorted[Math.floor(n / 2)];
    return median !== undefined ? [median] : [];
  }
  const out: number[] = [];
  for (let i = 0; i < cap; i++) {
    // Spread `cap` indices evenly across [0, n) — first slot at 0, last
    // slot at the highest sample, intermediate slots stride-spaced.
    const idx = Math.floor((i * (n - 1)) / (cap - 1));
    const v = sorted[idx];
    if (v !== undefined) out.push(v);
  }
  return out;
}

/**
 * Coerce a wrong-shaped persisted sampler back to a valid skeleton. A JS
 * caller, partial write, or malformed JSON deserialization can leave
 * `latency` itself, `samples`, `count`, or `cap` missing/wrong-typed.
 * Without this, `recordUsage` would crash on the first deref, and that
 * brick's telemetry would stop advancing until the record was repaired
 * manually. Heal at the boundary instead.
 */
function safeSampler(latency: LatencySampler | undefined | null): LatencySampler {
  const fallbackCap = 200;
  if (latency === undefined || latency === null || typeof latency !== "object") {
    return { samples: [], count: 0, cap: fallbackCap };
  }
  const samples = Array.isArray(latency.samples) ? latency.samples : [];
  // Wrong-typed `count` (e.g. "bogus") sentinel-coerces to NaN so the
  // downstream healer sees it as invalid and reconstructs from
  // `samples.length`. Coercing to 0 here would let a non-empty buffer
  // get re-counted as 0 → 1 after one event, making post-cap reservoir
  // probabilities `cap / newCount > 1` and breaking the sampler.
  const count = typeof latency.count === "number" ? latency.count : Number.NaN;
  const cap = typeof latency.cap === "number" ? latency.cap : fallbackCap;
  return { samples, count, cap };
}

/**
 * Normalise a possibly-corrupt sampler without adding a new sample.
 * Returns sanitised, sorted, cap-bounded buffer and a healed `count`
 * (≥ buffer length, finite non-negative integer, defaults to base length).
 * Used both before reservoir replacement and on the invalid-latency path
 * so a degraded producer cannot strand a sampler in a corrupt state.
 */
function healSampler(latency: LatencySampler): LatencySampler {
  const safe = safeSampler(latency);
  const cap = normaliseCap(safe.cap);
  let base: readonly number[] = isCleanSorted(safe.samples)
    ? safe.samples
    : sanitiseAndSort(safe.samples);
  if (base.length > cap) base = downsampleSortedToCap(base, cap);
  const count =
    Number.isFinite(safe.count) &&
    safe.count >= 0 &&
    Number.isInteger(safe.count) &&
    safe.count >= base.length
      ? safe.count
      : base.length;
  return { samples: [...base], count, cap };
}

function appendSampleSortedBounded(latency: LatencySampler, sample: number): LatencySampler {
  const safe = safeSampler(latency);
  const cap = normaliseCap(safe.cap);
  let base: readonly number[] = isCleanSorted(safe.samples)
    ? safe.samples
    : sanitiseAndSort(safe.samples);
  // Heal legacy oversized buffers via uniform downsampling so the slow
  // tail is not silently dropped — see `downsampleSortedToCap`.
  if (base.length > cap) base = downsampleSortedToCap(base, cap);
  // Heal corrupt persisted count: NaN + 1 = NaN forever, fractional /
  // negative breaks reservoir math, and a count smaller than the
  // sanitized buffer would let post-cap probability `cap/newCount > 1`
  // and turn replacement into unconditional churn. Reconstruct from
  // `base.length` whenever the stored count is invalid OR understates
  // the actual buffer.
  const priorCount =
    Number.isFinite(safe.count) &&
    safe.count >= 0 &&
    Number.isInteger(safe.count) &&
    safe.count >= base.length
      ? safe.count
      : base.length;
  const newCount = priorCount + 1;

  if (base.length < cap) {
    return { samples: sortedInsert(base, sample), count: newCount, cap };
  }

  // Deterministic reservoir: replace with probability cap / newCount.
  // Seed mixes `newCount` and the sample value so per-sample inclusion is
  // not a fixed function of position alone — different streams with the
  // same length get different decisions, restoring the cap/N inclusion
  // statistics in expectation while remaining replay-safe.
  const sampleSeed = Math.imul(Math.floor(sample) | 0, 0x85ebca6b);
  const decision = mulberry32(newCount ^ sampleSeed);
  if (decision >= cap / newCount) {
    return { samples: base, count: newCount, cap };
  }
  const victim = Math.floor(mulberry32(newCount ^ sampleSeed ^ 0x9e3779b9) * cap);
  const without = [...base.slice(0, victim), ...base.slice(victim + 1)];
  return { samples: sortedInsert(without, sample), count: newCount, cap };
}

export interface UsageEvent {
  readonly outcome: "success" | "error";
  /**
   * Latency in milliseconds. Must be a finite non-negative number.
   * Invalid values (NaN, Infinity, negative) cause the latency sample to
   * be SKIPPED — the outcome counter still advances, but the sample is
   * not appended to the reservoir. Mapping invalid latency to `0` would
   * inflate scoring (0 ≈ 1 ms baseline) for malformed producers.
   */
  readonly latencyMs: number;
  /** Epoch ms when the usage occurred. */
  readonly at: number;
}

function isValidLatency(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Compute the new `lastUsedAt` from an event timestamp and the caller-
 * supplied ingest-time ceiling. Throws on non-finite inputs (caller bug:
 * a JS caller dropping the third argument lands here, fails loudly, and
 * never silently corrupts stored recency state).
 */
function nextLastUsedAt(prior: number, eventAt: number, ingestNow: number): number {
  if (!Number.isFinite(eventAt) || !Number.isFinite(ingestNow)) {
    throw new TypeError(
      `recordUsage requires finite event.at and ingestNow; got event.at=${String(eventAt)}, ingestNow=${String(ingestNow)}`,
    );
  }
  // Heal corrupt persisted recency: `Math.max(NaN, x)` is NaN, which would
  // perpetuate a poisoned `lastUsedAt` across every future event and make
  // the brick look idle to retirement / unrankable to scoring forever.
  const safePrior = Number.isFinite(prior) && prior >= 0 ? prior : 0;
  // Clamp future-dated events to the ingest-clock ceiling rather than
  // dropping them: counters and latency for the same event still advance,
  // so leaving recency at `prior` would let a stream of future-stamped
  // events flow through `recordUsage` while `suggestRetirement` later
  // marks the brick idle (producer/consumer clock skew → false retire).
  // `min(eventAt, ingestNow)` keeps the result deterministic for a given
  // `(prior, event, ingestNow)` triple while still advancing recency.
  const clamped = Math.min(eventAt, ingestNow);
  return Math.max(safePrior, clamped);
}

/**
 * Pure update — returns a new `BrickFitnessMetrics` reflecting the event.
 *
 * `ingestNow` is the caller-supplied ingest-time ceiling: `event.at` is
 * clamped against it so a skewed/future event cannot poison recency, and
 * the same event replayed against the same `ingestNow` yields the same
 * `lastUsedAt` (deterministic). After clamping, recency advances
 * monotonically — out-of-order events do not move it backwards. Non-finite
 * timestamps throw a `TypeError` (fail loudly rather than silently
 * corrupt stored recency).
 *
 * **Idempotency contract:** `recordUsage` is *deterministic* (replaying
 * the same `(prior fitness, event, ingestNow)` triple returns the same
 * result), but it is NOT *exactly-once*. Every call increments counters
 * and appends latency. Callers integrating with at-least-once telemetry
 * pipelines must dedupe events upstream (e.g. by event ID / sequence)
 * before invoking; this package intentionally does not carry that state.
 */
/**
 * Coerce a persisted counter to a finite non-negative integer. A single
 * bad write can leave `NaN`, `Infinity`, fractional, or negative values
 * on disk; `NaN + 1` propagates forever. `recordUsage` heals silently so
 * one bad snapshot cannot freeze every subsequent telemetry event for
 * that brick — but the integrity signal is preserved out-of-band via
 * `detectFitnessIntegrity`, which callers should run alongside (or
 * before) `recordUsage` to drive a quarantine / repair pipeline.
 */
function safeCounter(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

// Integrity detection lives in a sibling file to keep usage.ts under the
// 400-line soft limit. Re-exported here for back-compat and so callers
// can import both from a single entry point.
export type { FitnessIntegrityIssue } from "./integrity.js";
export { detectFitnessIntegrity } from "./integrity.js";

import type { FitnessIntegrityIssue } from "./integrity.js";
import { detectFitnessIntegrity } from "./integrity.js";

/**
 * Optional callback invoked synchronously when `recordUsage` heals a
 * corrupt prior fitness snapshot. Wire into the production ingest path
 * so silent healing always emits a parallel integrity event — operators
 * see the corruption even though the write proceeds. Throwing from the
 * callback is the caller's choice (e.g. quarantine-then-retry).
 */
export type FitnessIntegrityListener = (issue: FitnessIntegrityIssue) => void;

export function recordUsage(
  fitness: BrickFitnessMetrics,
  event: UsageEvent,
  ingestNow: number,
  onIntegrity?: FitnessIntegrityListener,
): BrickFitnessMetrics {
  // Runtime guard: a JS caller or deserialized payload can pass anything.
  // Without this, an unknown outcome leaves both counters un-incremented
  // while latency / lastUsedAt advance, producing inconsistent telemetry.
  if (event.outcome !== "success" && event.outcome !== "error") {
    throw new TypeError(
      `recordUsage: unknown event.outcome ${JSON.stringify(event.outcome)}; expected "success" or "error"`,
    );
  }
  // Heal silently so a single bad snapshot does not freeze telemetry
  // forever for this brick — but emit an integrity event for every
  // corrupt prior field (multi-issue surface) so the production path
  // cannot persist healed state without observing all corruption.
  if (onIntegrity !== undefined) {
    for (const issue of detectFitnessIntegrity(fitness)) onIntegrity(issue);
  }
  // Top-level fitness shape — accept null / primitive / array by healing
  // from a default skeleton. Throwing here would freeze ingest for the
  // brick on a single bad deserialization payload.
  // biome-ignore lint/suspicious/noExplicitAny: accept any deserialized payload; healed below
  const f: any =
    fitness === null || typeof fitness !== "object" || Array.isArray(fitness)
      ? { successCount: 0, errorCount: 0, latency: null, lastUsedAt: 0 }
      : fitness;
  const priorSuccess = safeCounter(f.successCount);
  const priorError = safeCounter(f.errorCount);
  // Skip invalid latency rather than collapsing to 0 — `0` would be
  // interpreted as best-case latency (≈ 1ms after the score's clamp),
  // letting a malformed producer artificially inflate ranking. The
  // outcome counters still advance below. On the skip path we still
  // run the sampler through full healing so a degraded producer cannot
  // permanently strand the sampler in a corrupt state.
  const latency = isValidLatency(event.latencyMs)
    ? appendSampleSortedBounded(f.latency, event.latencyMs)
    : healSampler(f.latency);
  return {
    successCount: priorSuccess + (event.outcome === "success" ? 1 : 0),
    errorCount: priorError + (event.outcome === "error" ? 1 : 0),
    latency,
    lastUsedAt: nextLastUsedAt(f.lastUsedAt, event.at, ingestNow),
  };
}
