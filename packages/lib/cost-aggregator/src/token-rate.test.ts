import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTokenRateTracker } from "./token-rate.js";

describe("createTokenRateTracker", () => {
  // Use a fixed Date.now() for deterministic tests
  const originalNow = Date.now;
  let fakeNow = 1000000;

  beforeEach(() => {
    fakeNow = 1000000;
    Date.now = () => fakeNow;
  });

  afterEach(() => {
    Date.now = originalNow;
  });

  test("returns 0 with no samples", () => {
    const tracker = createTokenRateTracker();
    expect(tracker.inputPerSecond()).toBe(0);
    expect(tracker.outputPerSecond()).toBe(0);
  });

  test("returns 0 with single sample", () => {
    const tracker = createTokenRateTracker();
    tracker.record(100, 50);
    expect(tracker.inputPerSecond()).toBe(0);
  });

  test("computes rate over two samples", () => {
    const tracker = createTokenRateTracker(60_000);
    tracker.record(100, 50);
    fakeNow += 1000; // 1 second later
    tracker.record(200, 100);

    // Total: 300 input over 1 second
    expect(tracker.inputPerSecond()).toBeCloseTo(300, 0);
    // Total: 150 output over 1 second
    expect(tracker.outputPerSecond()).toBeCloseTo(150, 0);
  });

  test("rate decreases as window grows", () => {
    const tracker = createTokenRateTracker(60_000);
    tracker.record(100, 50);
    fakeNow += 10_000; // 10 seconds later
    tracker.record(100, 50);

    // Total: 200 input over 10 seconds = 20/s
    expect(tracker.inputPerSecond()).toBeCloseTo(20, 0);
  });

  test("old samples are pruned outside window", () => {
    const tracker = createTokenRateTracker(5_000); // 5s window
    tracker.record(1000, 500); // t=0
    fakeNow += 3_000;
    tracker.record(100, 50); // t=3s (in window)
    fakeNow += 3_000;
    tracker.record(100, 50); // t=6s — first sample now outside window

    // Window is 5s. At t=6s, only samples from t=1s+ are in window.
    // First sample (t=0) is pruned. Remaining: t=3s (100) + t=6s (100) over 3s = ~66.7/s
    const rate = tracker.inputPerSecond();
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(1000); // first sample's 1000 tokens should be pruned
  });

  test("clear resets all state", () => {
    const tracker = createTokenRateTracker();
    tracker.record(100, 50);
    fakeNow += 1000;
    tracker.record(200, 100);
    tracker.clear();

    expect(tracker.inputPerSecond()).toBe(0);
    expect(tracker.outputPerSecond()).toBe(0);
  });

  test("works after clear and re-record", () => {
    const tracker = createTokenRateTracker(60_000);
    tracker.record(100, 50);
    tracker.clear();

    tracker.record(50, 25);
    fakeNow += 2_000;
    tracker.record(50, 25);

    // 100 input over 2 seconds = 50/s
    expect(tracker.inputPerSecond()).toBeCloseTo(50, 0);
  });
});
