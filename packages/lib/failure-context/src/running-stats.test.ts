import { describe, expect, test } from "bun:test";
import { WELFORD_INITIAL, welfordStddev, welfordUpdate } from "@koi/welford-stats";
import { computeRunningStats } from "./running-stats.js";

describe("computeRunningStats", () => {
  test("returns zeros for initial state", () => {
    const stats = computeRunningStats(WELFORD_INITIAL);
    expect(stats).toEqual({ count: 0, mean: 0, stddev: 0 });
  });

  test("matches manual welfordStddev call", () => {
    let state = WELFORD_INITIAL;
    for (const v of [10, 20, 30]) {
      state = welfordUpdate(state, v);
    }
    const stats = computeRunningStats(state);
    expect(stats.count).toBe(3);
    expect(stats.mean).toBeCloseTo(20, 10);
    expect(stats.stddev).toBe(welfordStddev(state));
  });

  test("returns correct stddev for known dataset", () => {
    // Dataset: [2, 4, 4, 4, 5, 5, 7, 9] → mean=5, stddev=2
    let state = WELFORD_INITIAL;
    for (const v of [2, 4, 4, 4, 5, 5, 7, 9]) {
      state = welfordUpdate(state, v);
    }
    const stats = computeRunningStats(state);
    expect(stats.count).toBe(8);
    expect(stats.mean).toBeCloseTo(5, 10);
    expect(stats.stddev).toBeCloseTo(2, 5);
  });
});
