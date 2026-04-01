/**
 * Pressure trend tracker tests (ported from v1 with additions).
 */

import { describe, expect, it } from "bun:test";
import { createPressureTrendTracker } from "./pressure-trend.js";

describe("createPressureTrendTracker", () => {
  it("returns -1 estimatedTurnsToCompaction with zero samples", () => {
    const tracker = createPressureTrendTracker();
    const trend = tracker.compute(100_000);
    expect(trend.sampleCount).toBe(0);
    expect(trend.growthPerTurn).toBe(0);
    expect(trend.estimatedTurnsToCompaction).toBe(-1);
  });

  it("returns -1 estimatedTurnsToCompaction with one sample", () => {
    const tracker = createPressureTrendTracker();
    tracker.record(10_000);
    const trend = tracker.compute(100_000);
    expect(trend.sampleCount).toBe(1);
    expect(trend.estimatedTurnsToCompaction).toBe(-1);
  });

  it("computes growth per turn from two samples", () => {
    const tracker = createPressureTrendTracker();
    tracker.record(10_000);
    tracker.record(15_000);
    const trend = tracker.compute(100_000);
    expect(trend.sampleCount).toBe(2);
    expect(trend.growthPerTurn).toBe(5_000);
  });

  it("estimates turns to compaction", () => {
    const tracker = createPressureTrendTracker();
    tracker.record(10_000);
    tracker.record(15_000);
    const trend = tracker.compute(100_000);
    // remaining: 100_000 - 15_000 = 85_000; turns: ceil(85_000 / 5_000) = 17
    expect(trend.estimatedTurnsToCompaction).toBe(17);
  });

  it("returns -1 when growth is zero", () => {
    const tracker = createPressureTrendTracker();
    tracker.record(50_000);
    tracker.record(50_000);
    const trend = tracker.compute(100_000);
    expect(trend.growthPerTurn).toBe(0);
    expect(trend.estimatedTurnsToCompaction).toBe(-1);
  });

  it("returns -1 when growth is negative (shrinking)", () => {
    const tracker = createPressureTrendTracker();
    tracker.record(50_000);
    tracker.record(40_000);
    const trend = tracker.compute(100_000);
    expect(trend.growthPerTurn).toBe(-10_000);
    expect(trend.estimatedTurnsToCompaction).toBe(-1);
  });

  it("returns -1 when already above threshold", () => {
    const tracker = createPressureTrendTracker();
    tracker.record(80_000);
    tracker.record(110_000);
    const trend = tracker.compute(100_000);
    expect(trend.estimatedTurnsToCompaction).toBe(-1);
  });

  it("wraps around circular buffer", () => {
    const tracker = createPressureTrendTracker(3);
    tracker.record(10_000); // slot 0
    tracker.record(20_000); // slot 1
    tracker.record(30_000); // slot 2
    tracker.record(40_000); // slot 0 (overwrites 10K)
    // Chronological: [20K, 30K, 40K]
    const trend = tracker.compute(100_000);
    expect(trend.sampleCount).toBe(3);
    // growth: (40K - 20K) / (3-1) = 10K per turn
    expect(trend.growthPerTurn).toBe(10_000);
  });

  it("throws on invalid windowSize", () => {
    expect(() => createPressureTrendTracker(0)).toThrow();
    expect(() => createPressureTrendTracker(-1)).toThrow();
    expect(() => createPressureTrendTracker(1.5)).toThrow();
  });

  it("reports correct sampleCount", () => {
    const tracker = createPressureTrendTracker(5);
    expect(tracker.sampleCount()).toBe(0);
    tracker.record(1);
    expect(tracker.sampleCount()).toBe(1);
    tracker.record(2);
    tracker.record(3);
    tracker.record(4);
    tracker.record(5);
    expect(tracker.sampleCount()).toBe(5);
    tracker.record(6); // wraps, still 5
    expect(tracker.sampleCount()).toBe(5);
  });
});
