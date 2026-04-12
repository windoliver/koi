import { describe, expect, test } from "bun:test";
import { createLatencyTracker } from "./latency-tracker.js";

describe("createLatencyTracker", () => {
  test("returns undefined percentiles with 0 samples", () => {
    const t = createLatencyTracker();
    expect(t.getPercentiles()).toBeUndefined();
  });

  test("returns undefined percentiles with 1 sample", () => {
    const t = createLatencyTracker();
    t.record(100);
    expect(t.getPercentiles()).toBeUndefined();
  });

  test("returns percentiles with 2+ samples", () => {
    const t = createLatencyTracker();
    t.record(100);
    t.record(200);
    const p = t.getPercentiles();
    expect(p).not.toBeUndefined();
  });

  test("p50 is median of sorted samples", () => {
    const t = createLatencyTracker();
    // 10 samples: 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
    for (let i = 1; i <= 10; i++) t.record(i * 10);
    const p = t.getPercentiles();
    expect(p).not.toBeUndefined();
    // p50 index = Math.floor(10 * 0.5) = 5 → sorted[5] = 60
    expect(p?.p50Ms).toBe(60);
  });

  test("p95 captures 95th percentile", () => {
    const t = createLatencyTracker();
    // 20 samples: 10, 20, ..., 200
    for (let i = 1; i <= 20; i++) t.record(i * 10);
    const p = t.getPercentiles();
    // p95 index = Math.floor(20 * 0.95) = 19 → sorted[19] = 200
    expect(p?.p95Ms).toBe(200);
  });

  test("sampleCount reflects total up to windowSize", () => {
    const t = createLatencyTracker(5);
    expect(t.sampleCount()).toBe(0);
    t.record(1);
    t.record(2);
    expect(t.sampleCount()).toBe(2);
    // Fill past window
    t.record(3);
    t.record(4);
    t.record(5);
    t.record(6);
    expect(t.sampleCount()).toBe(5);
  });

  test("circular buffer evicts oldest sample when full", () => {
    // Window of 3: record 10, 20, 30, then 1000
    const t = createLatencyTracker(3);
    t.record(10);
    t.record(20);
    t.record(30);
    t.record(1000); // overwrites 10
    const p = t.getPercentiles();
    // Buffer should contain 20, 30, 1000 — not 10
    expect(p?.p50Ms).toBe(30); // sorted: [20, 30, 1000], p50 index=1
    expect(p?.p95Ms).toBe(1000);
  });

  test("all same values → p50 and p95 are equal", () => {
    const t = createLatencyTracker();
    for (let i = 0; i < 100; i++) t.record(42);
    const p = t.getPercentiles();
    expect(p?.p50Ms).toBe(42);
    expect(p?.p95Ms).toBe(42);
  });
});
