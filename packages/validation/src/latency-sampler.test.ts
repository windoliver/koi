import { describe, expect, test } from "bun:test";
import type { LatencySampler } from "@koi/core";
import {
  computePercentile,
  createLatencySampler,
  mergeSamplers,
  recordLatency,
} from "./latency-sampler.js";

describe("createLatencySampler", () => {
  test("creates empty sampler with default cap", () => {
    const s = createLatencySampler();
    expect(s.samples).toEqual([]);
    expect(s.count).toBe(0);
    expect(s.cap).toBe(200);
  });

  test("creates empty sampler with custom cap", () => {
    const s = createLatencySampler(50);
    expect(s.cap).toBe(50);
  });

  test("clamps cap to minimum of 1", () => {
    const s = createLatencySampler(0);
    expect(s.cap).toBe(1);
  });

  test("rounds fractional cap", () => {
    const s = createLatencySampler(3.7);
    expect(s.cap).toBe(4);
  });
});

describe("recordLatency", () => {
  test("inserts first sample", () => {
    const s = createLatencySampler(10);
    const result = recordLatency(s, 42);
    expect(result.samples).toEqual([42]);
    expect(result.count).toBe(1);
  });

  test("maintains sorted order", () => {
    let s = createLatencySampler(10);
    s = recordLatency(s, 30);
    s = recordLatency(s, 10);
    s = recordLatency(s, 20);
    expect(result(s)).toEqual([10, 20, 30]);
  });

  test("never mutates the original sampler", () => {
    const original = createLatencySampler(10);
    const updated = recordLatency(original, 42);
    expect(original.samples).toEqual([]);
    expect(original.count).toBe(0);
    expect(updated.samples).toEqual([42]);
  });

  test("fills to capacity", () => {
    let s = createLatencySampler(3);
    s = recordLatency(s, 30);
    s = recordLatency(s, 10);
    s = recordLatency(s, 20);
    expect(result(s)).toEqual([10, 20, 30]);
    expect(s.count).toBe(3);
    expect(s.samples.length).toBe(3);
  });

  test("reservoir sampling keeps buffer at cap size", () => {
    let s = createLatencySampler(5);
    for (let i = 0; i < 100; i++) {
      s = recordLatency(s, i);
    }
    expect(s.count).toBe(100);
    expect(s.samples.length).toBe(5);
    // Samples should still be sorted
    for (let i = 1; i < s.samples.length; i++) {
      const current = s.samples[i];
      const prev = s.samples[i - 1];
      if (current !== undefined && prev !== undefined) {
        expect(current).toBeGreaterThanOrEqual(prev);
      }
    }
  });

  test("handles duplicate values", () => {
    let s = createLatencySampler(10);
    s = recordLatency(s, 5);
    s = recordLatency(s, 5);
    s = recordLatency(s, 5);
    expect(result(s)).toEqual([5, 5, 5]);
  });
});

describe("computePercentile", () => {
  test("returns undefined for empty sampler", () => {
    const s = createLatencySampler();
    expect(computePercentile(s, 0.99)).toBeUndefined();
  });

  test("returns the single sample for a 1-element buffer", () => {
    let s = createLatencySampler();
    s = recordLatency(s, 42);
    expect(computePercentile(s, 0.5)).toBe(42);
    expect(computePercentile(s, 0.99)).toBe(42);
  });

  test("returns correct P50 for sorted samples", () => {
    const s: LatencySampler = {
      samples: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
      count: 10,
      cap: 200,
    };
    const p50 = computePercentile(s, 0.5);
    expect(p50).toBe(60); // index = floor(0.5 * 10) = 5
  });

  test("returns correct P99 for sorted samples", () => {
    const s: LatencySampler = {
      samples: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
      count: 10,
      cap: 200,
    };
    const p99 = computePercentile(s, 0.99);
    expect(p99).toBe(100); // index = min(floor(0.99 * 10), 9) = 9
  });

  test("returns first element for P0", () => {
    const s: LatencySampler = {
      samples: [10, 20, 30],
      count: 3,
      cap: 200,
    };
    expect(computePercentile(s, 0)).toBe(10);
  });

  test("returns last element for P100", () => {
    const s: LatencySampler = {
      samples: [10, 20, 30],
      count: 3,
      cap: 200,
    };
    expect(computePercentile(s, 1.0)).toBe(30);
  });

  test("clamps percentile below 0", () => {
    const s: LatencySampler = { samples: [10, 20, 30], count: 3, cap: 200 };
    expect(computePercentile(s, -0.5)).toBe(10);
  });

  test("clamps percentile above 1", () => {
    const s: LatencySampler = { samples: [10, 20, 30], count: 3, cap: 200 };
    expect(computePercentile(s, 1.5)).toBe(30);
  });
});

describe("mergeSamplers", () => {
  test("merges two empty samplers", () => {
    const a = createLatencySampler(10);
    const b = createLatencySampler(10);
    const merged = mergeSamplers(a, b);
    expect(merged.samples).toEqual([]);
    expect(merged.count).toBe(0);
  });

  test("merges one empty and one non-empty", () => {
    const a: LatencySampler = { samples: [10, 20, 30], count: 3, cap: 10 };
    const b = createLatencySampler(10);
    const merged = mergeSamplers(a, b);
    expect(merged.samples).toEqual([10, 20, 30]);
    expect(merged.count).toBe(3);
  });

  test("merges two non-empty samplers maintaining sort order", () => {
    const a: LatencySampler = { samples: [10, 30, 50], count: 3, cap: 10 };
    const b: LatencySampler = { samples: [20, 40, 60], count: 3, cap: 10 };
    const merged = mergeSamplers(a, b);
    expect(merged.samples).toEqual([10, 20, 30, 40, 50, 60]);
    expect(merged.count).toBe(6);
  });

  test("uses max cap from both inputs", () => {
    const a: LatencySampler = { samples: [10], count: 1, cap: 5 };
    const b: LatencySampler = { samples: [20], count: 1, cap: 15 };
    const merged = mergeSamplers(a, b);
    expect(merged.cap).toBe(15);
  });

  test("downsamples when merged exceeds cap", () => {
    const a: LatencySampler = { samples: [10, 20, 30, 40, 50], count: 5, cap: 5 };
    const b: LatencySampler = { samples: [15, 25, 35, 45, 55], count: 5, cap: 5 };
    const merged = mergeSamplers(a, b);
    expect(merged.samples.length).toBe(5);
    expect(merged.count).toBe(10);
    // Should still be sorted
    for (let i = 1; i < merged.samples.length; i++) {
      const current = merged.samples[i];
      const prev = merged.samples[i - 1];
      if (current !== undefined && prev !== undefined) {
        expect(current).toBeGreaterThanOrEqual(prev);
      }
    }
  });

  test("sums total count from both samplers", () => {
    const a: LatencySampler = { samples: [10], count: 50, cap: 5 };
    const b: LatencySampler = { samples: [20], count: 30, cap: 5 };
    const merged = mergeSamplers(a, b);
    expect(merged.count).toBe(80);
  });
});

// Helper to extract samples array for readability
function result(s: LatencySampler): readonly number[] {
  return s.samples;
}
