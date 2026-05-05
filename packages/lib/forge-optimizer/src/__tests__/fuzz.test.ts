/**
 * Property-based fuzz tests.
 *
 * Pure functions are ideal for property tests: invariants must hold for
 * every input, not just the curated examples in the unit tests. These
 * cases catch corner cases the hand-written tests miss (e.g. specific
 * float boundaries, sample ordering edge cases, replay determinism
 * regressions on rare inputs).
 */

import { describe, expect, test } from "bun:test";
import type { BrickFitnessMetrics } from "@koi/core";
import * as fc from "fast-check";
import { computePerformanceScore } from "../performance.js";
import { recordUsage, type UsageEvent } from "../usage.js";

const fcSamplesCap = 64;

const fcLatencySampler = fc
  .record({
    count: fc.integer({ min: 0, max: 1_000_000 }),
    cap: fc.integer({ min: 1, max: fcSamplesCap }),
    rawSamples: fc.array(fc.double({ min: 0, max: 100_000, noNaN: true }), {
      maxLength: fcSamplesCap,
    }),
  })
  .map(({ count, cap, rawSamples }) => {
    const sorted = [...rawSamples].sort((a, b) => a - b).slice(0, cap);
    return {
      samples: sorted,
      count: Math.max(count, sorted.length),
      cap,
    };
  });

const fcFitness: fc.Arbitrary<BrickFitnessMetrics> = fc.record({
  successCount: fc.integer({ min: 0, max: 1_000_000 }),
  errorCount: fc.integer({ min: 0, max: 1_000_000 }),
  latency: fcLatencySampler,
  lastUsedAt: fc.integer({ min: 0, max: 10_000_000_000 }),
});

const fcEvent: fc.Arbitrary<UsageEvent> = fc.record({
  outcome: fc.constantFrom("success", "error") as fc.Arbitrary<"success" | "error">,
  latencyMs: fc.double({ min: 0, max: 100_000, noNaN: true }),
  at: fc.integer({ min: 0, max: 10_000_000_000 }),
});

describe("recordUsage — invariants over arbitrary input", () => {
  test("counters never go negative; integer counters stay integer", () => {
    fc.assert(
      fc.property(fcFitness, fcEvent, fc.integer({ min: 0, max: 10_000_000_000 }), (f, e, now) => {
        const next = recordUsage(f, e, now);
        expect(next.successCount).toBeGreaterThanOrEqual(0);
        expect(next.errorCount).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(next.successCount)).toBe(true);
        expect(Number.isInteger(next.errorCount)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  test("exactly one of (success, error) increments by one per event; the other is unchanged", () => {
    fc.assert(
      fc.property(fcFitness, fcEvent, fc.integer({ min: 0, max: 10_000_000_000 }), (f, e, now) => {
        const next = recordUsage(f, e, now);
        if (e.outcome === "success") {
          expect(next.successCount - f.successCount).toBe(1);
          expect(next.errorCount - f.errorCount).toBe(0);
        } else {
          expect(next.errorCount - f.errorCount).toBe(1);
          expect(next.successCount - f.successCount).toBe(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  test("sampler invariants hold post-event: sorted ascending, length <= cap, count >= length", () => {
    fc.assert(
      fc.property(fcFitness, fcEvent, fc.integer({ min: 0, max: 10_000_000_000 }), (f, e, now) => {
        const next = recordUsage(f, e, now);
        expect(next.latency.samples.length).toBeLessThanOrEqual(next.latency.cap);
        expect(next.latency.count).toBeGreaterThanOrEqual(next.latency.samples.length);
        for (let i = 1; i < next.latency.samples.length; i++) {
          expect(next.latency.samples[i]).toBeGreaterThanOrEqual(next.latency.samples[i - 1] ?? 0);
        }
      }),
      { numRuns: 200 },
    );
  });

  test("lastUsedAt is monotonic forward and never exceeds max(prior, ingestNow)", () => {
    fc.assert(
      fc.property(fcFitness, fcEvent, fc.integer({ min: 0, max: 10_000_000_000 }), (f, e, now) => {
        const next = recordUsage(f, e, now);
        expect(next.lastUsedAt).toBeGreaterThanOrEqual(f.lastUsedAt);
        expect(next.lastUsedAt).toBeLessThanOrEqual(Math.max(f.lastUsedAt, now));
      }),
      { numRuns: 200 },
    );
  });

  test("replay determinism: identical (fitness, event, now) yields identical result", () => {
    fc.assert(
      fc.property(fcFitness, fcEvent, fc.integer({ min: 0, max: 10_000_000_000 }), (f, e, now) => {
        const a = recordUsage(f, e, now);
        const b = recordUsage(f, e, now);
        expect(a).toEqual(b);
      }),
      { numRuns: 200 },
    );
  });

  test("does not mutate input fitness", () => {
    fc.assert(
      fc.property(fcFitness, fcEvent, fc.integer({ min: 0, max: 10_000_000_000 }), (f, e, now) => {
        const snapshot = JSON.stringify(f);
        recordUsage(f, e, now);
        expect(JSON.stringify(f)).toBe(snapshot);
      }),
      { numRuns: 200 },
    );
  });
});

describe("computePerformanceScore — invariants over arbitrary input", () => {
  test("score is always finite and non-negative", () => {
    fc.assert(
      fc.property(fcFitness, fc.integer({ min: 0, max: 10_000_000_000 }), (f, now) => {
        const s = computePerformanceScore(f, now);
        expect(Number.isFinite(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });

  test("recency monotonicity: same fitness, more recent lastUsedAt → score ≥ older", () => {
    fc.assert(
      fc.property(
        fcFitness,
        fc.integer({ min: 1_000_000, max: 10_000_000_000 }),
        fc.integer({ min: 0, max: 999_999 }),
        (base, now, ageDelta) => {
          // Construct two snapshots: same counters/latency, different
          // lastUsedAt. Skip cases where the scorer fails closed (returns 0
          // for one snapshot and not the other).
          const fresh: BrickFitnessMetrics = { ...base, lastUsedAt: now };
          const stale: BrickFitnessMetrics = { ...base, lastUsedAt: now - ageDelta };
          const sFresh = computePerformanceScore(fresh, now);
          const sStale = computePerformanceScore(stale, now);
          expect(sFresh).toBeGreaterThanOrEqual(sStale);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("score is deterministic (same input → same score)", () => {
    fc.assert(
      fc.property(fcFitness, fc.integer({ min: 0, max: 10_000_000_000 }), (f, now) => {
        expect(computePerformanceScore(f, now)).toBe(computePerformanceScore(f, now));
      }),
      { numRuns: 200 },
    );
  });
});

describe("recordUsage stream invariants", () => {
  test("100-event stream: counters total = events processed, recency monotonic", () => {
    fc.assert(
      fc.property(fc.array(fcEvent, { minLength: 1, maxLength: 100 }), (events) => {
        let s: BrickFitnessMetrics = {
          successCount: 0,
          errorCount: 0,
          latency: { samples: [], count: 0, cap: 32 },
          lastUsedAt: 0,
        };
        let prevRecency = 0;
        let now = 0;
        let successes = 0;
        let errors = 0;
        for (const e of events) {
          now = Math.max(now, e.at) + 1;
          s = recordUsage(s, e, now);
          expect(s.lastUsedAt).toBeGreaterThanOrEqual(prevRecency);
          prevRecency = s.lastUsedAt;
          if (e.outcome === "success") successes++;
          else errors++;
        }
        expect(s.successCount).toBe(successes);
        expect(s.errorCount).toBe(errors);
        // count tracks total invocations (latency may be skipped on invalid
        // values, but our generator excludes NaN, so count == events.length)
        expect(s.latency.count).toBe(events.length);
        expect(s.latency.samples.length).toBeLessThanOrEqual(s.latency.cap);
      }),
      { numRuns: 50 },
    );
  });
});
