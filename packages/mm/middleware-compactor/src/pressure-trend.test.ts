import { describe, expect, test } from "bun:test";
import { createPressureTrendTracker } from "./pressure-trend.js";

describe("createPressureTrendTracker", () => {
  test("0 samples → sampleCount=0, estimatedTurns=-1, growthPerTurn=0", () => {
    const tracker = createPressureTrendTracker();
    const trend = tracker.compute(150_000);
    expect(trend.sampleCount).toBe(0);
    expect(trend.estimatedTurnsToCompaction).toBe(-1);
    expect(trend.growthPerTurn).toBe(0);
  });

  test("1 sample → sampleCount=1, estimatedTurns=-1", () => {
    const tracker = createPressureTrendTracker();
    tracker.record(10_000);
    const trend = tracker.compute(150_000);
    expect(trend.sampleCount).toBe(1);
    expect(trend.estimatedTurnsToCompaction).toBe(-1);
    expect(trend.growthPerTurn).toBe(0);
  });

  test("2+ samples with positive growth → correct estimatedTurns", () => {
    const tracker = createPressureTrendTracker();
    tracker.record(100_000);
    tracker.record(110_000);
    tracker.record(120_000);
    const trend = tracker.compute(150_000);
    expect(trend.sampleCount).toBe(3);
    expect(trend.growthPerTurn).toBe(10_000);
    // remaining = 150_000 - 120_000 = 30_000, ceil(30_000 / 10_000) = 3
    expect(trend.estimatedTurnsToCompaction).toBe(3);
  });

  test("shrinking context → growthPerTurn < 0, estimatedTurns=-1", () => {
    const tracker = createPressureTrendTracker();
    tracker.record(120_000);
    tracker.record(100_000);
    const trend = tracker.compute(150_000);
    expect(trend.growthPerTurn).toBe(-20_000);
    expect(trend.estimatedTurnsToCompaction).toBe(-1);
  });

  test("already above threshold → estimatedTurns=-1", () => {
    const tracker = createPressureTrendTracker();
    tracker.record(100_000);
    tracker.record(160_000);
    const trend = tracker.compute(150_000);
    expect(trend.growthPerTurn).toBe(60_000);
    expect(trend.estimatedTurnsToCompaction).toBe(-1);
  });

  test("circular buffer wrapping (windowSize=3, record 5 samples)", () => {
    const tracker = createPressureTrendTracker(3);
    tracker.record(10_000); // evicted
    tracker.record(20_000); // evicted
    tracker.record(30_000);
    tracker.record(40_000);
    tracker.record(50_000);
    expect(tracker.sampleCount()).toBe(3);
    const trend = tracker.compute(100_000);
    // Chronological: [30_000, 40_000, 50_000]
    expect(trend.growthPerTurn).toBe(10_000);
    // remaining = 100_000 - 50_000 = 50_000, ceil(50_000 / 10_000) = 5
    expect(trend.estimatedTurnsToCompaction).toBe(5);
  });

  test("zero growth (flat) → growthPerTurn=0, estimatedTurns=-1", () => {
    const tracker = createPressureTrendTracker();
    tracker.record(50_000);
    tracker.record(50_000);
    tracker.record(50_000);
    const trend = tracker.compute(150_000);
    expect(trend.growthPerTurn).toBe(0);
    expect(trend.estimatedTurnsToCompaction).toBe(-1);
  });

  test("sampleCount returns min(totalRecorded, windowSize)", () => {
    const tracker = createPressureTrendTracker(3);
    expect(tracker.sampleCount()).toBe(0);
    tracker.record(1);
    expect(tracker.sampleCount()).toBe(1);
    tracker.record(2);
    expect(tracker.sampleCount()).toBe(2);
    tracker.record(3);
    expect(tracker.sampleCount()).toBe(3);
    tracker.record(4);
    expect(tracker.sampleCount()).toBe(3); // capped at windowSize
    tracker.record(5);
    expect(tracker.sampleCount()).toBe(3);
  });

  test("estimatedTurns rounds up for fractional turns", () => {
    const tracker = createPressureTrendTracker();
    tracker.record(0);
    tracker.record(30_000);
    // growthPerTurn = 30_000, remaining = 100_000 - 30_000 = 70_000
    // 70_000 / 30_000 = 2.33... → ceil → 3
    const trend = tracker.compute(100_000);
    expect(trend.estimatedTurnsToCompaction).toBe(3);
  });
});
