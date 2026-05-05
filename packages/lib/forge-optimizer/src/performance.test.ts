import { describe, expect, test } from "bun:test";
import type { BrickFitnessMetrics } from "@koi/core";
import { computePerformanceScore } from "./performance.js";

const WINDOW = 7 * 24 * 60 * 60 * 1000; // 7 days

function fitness(overrides: Partial<BrickFitnessMetrics> = {}): BrickFitnessMetrics {
  return {
    successCount: 0,
    errorCount: 0,
    latency: { samples: [], count: 0, cap: 200 },
    lastUsedAt: 0,
    ...overrides,
  };
}

describe("computePerformanceScore", () => {
  test("returns 0 when no invocations", () => {
    expect(computePerformanceScore(fitness(), 0)).toBe(0);
  });

  test("higher success rate yields higher score (same latency, same recency)", () => {
    const now = WINDOW;
    const lo = computePerformanceScore(
      fitness({
        successCount: 1,
        errorCount: 9,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: now,
      }),
      now,
    );
    const hi = computePerformanceScore(
      fitness({
        successCount: 9,
        errorCount: 1,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: now,
      }),
      now,
    );
    expect(hi).toBeGreaterThan(lo);
  });

  test("lower latency yields higher score", () => {
    const now = WINDOW;
    const slow = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [1000], count: 1, cap: 200 },
        lastUsedAt: now,
      }),
      now,
    );
    const fast = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: now,
      }),
      now,
    );
    expect(fast).toBeGreaterThan(slow);
  });

  test("recency factor halves over evaluation window", () => {
    const old = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: 0,
      }),
      WINDOW,
    );
    const fresh = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: WINDOW,
      }),
      WINDOW,
    );
    expect(old).toBeCloseTo(fresh / 2, 6);
  });

  test("clamps avg latency to >= 1ms (no division by zero)", () => {
    const zero = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [0], count: 1, cap: 200 },
        lastUsedAt: 1,
      }),
      1,
    );
    expect(Number.isFinite(zero)).toBe(true);
    expect(zero).toBeGreaterThan(0);
  });

  test("returns 0 on wrong-shaped fitness.latency (does not throw on bad batch input)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: simulating malformed deserialized record
    const bad: any = { successCount: 5, errorCount: 0, latency: null, lastUsedAt: 1 };
    expect(() => computePerformanceScore(bad, 1)).not.toThrow();
    expect(computePerformanceScore(bad, 1)).toBe(0);

    // biome-ignore lint/suspicious/noExplicitAny: simulating wrong-typed fields
    const bad2: any = {
      successCount: 5,
      errorCount: 0,
      latency: { samples: "oops", count: "nope", cap: 200 },
      lastUsedAt: 1,
    };
    expect(computePerformanceScore(bad2, 1)).toBe(0);
  });

  test("scores by P99 latency, not mean (rare slow tail dominates)", () => {
    // 99 fast samples + 1 slow sample. Mean is ~14ms; P99 is 1000ms.
    // Pre-fix bug: mean-based scoring would rank this brick as if it
    // were ~14ms fast, hiding the slow-tail regression.
    const slowTail = [...Array.from({ length: 99 }, () => 5), 1000].sort((a, b) => a - b);
    const fastFitness = fitness({
      successCount: 100,
      errorCount: 0,
      latency: { samples: Array.from({ length: 100 }, () => 5), count: 100, cap: 200 },
      lastUsedAt: 1,
    });
    const tailFitness = fitness({
      successCount: 100,
      errorCount: 0,
      latency: { samples: slowTail, count: 100, cap: 200 },
      lastUsedAt: 1,
    });
    const fast = computePerformanceScore(fastFitness, 1);
    const slow = computePerformanceScore(tailFitness, 1);
    // Slow-tail brick must score worse than the consistently-fast one.
    expect(slow).toBeLessThan(fast);
  });

  test("fails closed when counters > 0 but latency buffer is empty (partial telemetry)", () => {
    // total > 0 but no latency samples must NOT score as 1ms baseline —
    // that would outrank real fast bricks despite having no measurement.
    const score = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [], count: 0, cap: 200 },
        lastUsedAt: 1,
      }),
      1,
    );
    expect(score).toBe(0);
  });

  test("respects custom evaluationWindowMs", () => {
    const half = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: 0,
      }),
      1000,
      { evaluationWindowMs: 1000 },
    );
    const full = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: 1000,
      }),
      1000,
      { evaluationWindowMs: 1000 },
    );
    expect(half).toBeCloseTo(full / 2, 6);
  });

  test("returns 0 on fractional counters (partial-write detection)", () => {
    const s = computePerformanceScore(
      fitness({
        successCount: 4.5,
        errorCount: 0,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: WINDOW,
      }),
      WINDOW,
    );
    expect(s).toBe(0);
  });

  test("returns 0 when both counters are malformed", () => {
    const s = computePerformanceScore(
      fitness({
        successCount: Number.NaN,
        errorCount: Number.POSITIVE_INFINITY,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: 0,
      }),
      WINDOW,
    );
    expect(s).toBe(0);
  });

  test("returns 0 when only one counter is malformed (fail-closed, no partial-credit)", () => {
    const s = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: Number.NaN,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: WINDOW,
      }),
      WINDOW,
    );
    expect(s).toBe(0);
  });

  test("returns 0 when latency.count is malformed (NaN)", () => {
    const s = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [10], count: Number.NaN, cap: 200 },
        lastUsedAt: WINDOW,
      }),
      WINDOW,
    );
    expect(s).toBe(0);
  });

  test("returns 0 when sampler invariant is broken (count>0 but samples=[])", () => {
    const s = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [], count: 5, cap: 200 },
        lastUsedAt: WINDOW,
      }),
      WINDOW,
    );
    expect(s).toBe(0);
  });

  test("returns 0 when latency buffer is non-empty but every sample is invalid", () => {
    const s = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: {
          samples: [Number.NaN, Number.POSITIVE_INFINITY, -1],
          count: 3,
          cap: 200,
        },
        lastUsedAt: WINDOW,
      }),
      WINDOW,
    );
    expect(s).toBe(0);
  });

  test("fails closed on mixed-validity latency buffer (does not score on curated subset)", () => {
    // Pre-fix bug: filtering out invalid samples and scoring on the
    // remainder let a corrupted buffer like [10, NaN, Infinity] score as
    // 10ms — artificially fast and outranking healthy bricks.
    const s = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [Number.NaN, Number.POSITIVE_INFINITY, 10], count: 3, cap: 200 },
        lastUsedAt: WINDOW,
      }),
      WINDOW,
    );
    expect(s).toBe(0);
  });

  test("falls back to default window when evaluationWindowMs is non-positive", () => {
    const s = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: WINDOW,
      }),
      WINDOW,
      { evaluationWindowMs: 0 },
    );
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeGreaterThan(0);
  });

  test("falls back to default window when evaluationWindowMs is non-finite", () => {
    const s = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: WINDOW,
      }),
      WINDOW,
      { evaluationWindowMs: Number.NaN },
    );
    expect(Number.isFinite(s)).toBe(true);
  });

  test("returns 0 for non-finite `now` (fail-closed; corrupted clock cannot inflate ranking)", () => {
    const s = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: 0,
      }),
      Number.NaN,
    );
    expect(s).toBe(0);
  });

  test("clamps future lastUsedAt to now (small clock skew yields elapsed=0, not score=0)", () => {
    const skewed = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: WINDOW * 100,
      }),
      WINDOW,
    );
    const fresh = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: WINDOW,
      }),
      WINDOW,
    );
    expect(skewed).toBe(fresh);
  });

  test("returns 0 for non-finite lastUsedAt (corrupted timestamp cannot beat real ones)", () => {
    const s = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: Number.NaN,
      }),
      WINDOW,
    );
    expect(s).toBe(0);
  });

  test("returns 0 when latency.count is less than samples.length (partial-write)", () => {
    const s = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [10, 20, 30], count: 1, cap: 200 },
        lastUsedAt: WINDOW,
      }),
      WINDOW,
    );
    expect(s).toBe(0);
  });

  test("returns 0 when samples.length exceeds cap (oversized legacy record)", () => {
    const s = computePerformanceScore(
      fitness({
        successCount: 5,
        errorCount: 0,
        latency: { samples: [10, 20, 30], count: 3, cap: 2 },
        lastUsedAt: WINDOW,
      }),
      WINDOW,
    );
    expect(s).toBe(0);
  });

  test("returns 0 when latency.cap is invalid (zero, negative, non-integer, NaN)", () => {
    for (const cap of [0, -1, 1.5, Number.NaN]) {
      const s = computePerformanceScore(
        fitness({
          successCount: 5,
          errorCount: 0,
          latency: { samples: [10], count: 1, cap },
          lastUsedAt: WINDOW,
        }),
        WINDOW,
      );
      expect(s).toBe(0);
    }
  });

  test("returns 0 on null / primitive / array fitness (does not throw on bad batch input)", () => {
    for (const bad of [null, undefined, 0, "x", [] as unknown]) {
      // biome-ignore lint/suspicious/noExplicitAny: simulating malformed deserialized record
      expect(() => computePerformanceScore(bad as any, 1)).not.toThrow();
      // biome-ignore lint/suspicious/noExplicitAny: simulating malformed deserialized record
      expect(computePerformanceScore(bad as any, 1)).toBe(0);
    }
  });

  test("score is always non-negative", () => {
    const s = computePerformanceScore(
      fitness({
        successCount: 0,
        errorCount: 5,
        latency: { samples: [10], count: 1, cap: 200 },
        lastUsedAt: 0,
      }),
      WINDOW,
    );
    expect(s).toBeGreaterThanOrEqual(0);
  });
});
