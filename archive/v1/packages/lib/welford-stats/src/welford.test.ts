import { describe, expect, test } from "bun:test";
import { WELFORD_INITIAL, welfordStddev, welfordUpdate, welfordVariance } from "./welford.js";

describe("welfordUpdate", () => {
  test("WELFORD_INITIAL has zero count, mean, and m2", () => {
    expect(WELFORD_INITIAL).toEqual({ count: 0, mean: 0, m2: 0 });
  });

  test("single value gives correct mean and zero variance", () => {
    const state = welfordUpdate(WELFORD_INITIAL, 42);
    expect(state.count).toBe(1);
    expect(state.mean).toBe(42);
    expect(state.m2).toBe(0);
  });

  test("two identical values give zero variance", () => {
    let state = welfordUpdate(WELFORD_INITIAL, 5);
    state = welfordUpdate(state, 5);
    expect(state.count).toBe(2);
    expect(state.mean).toBe(5);
    expect(welfordVariance(state)).toBe(0);
    expect(welfordStddev(state)).toBe(0);
  });

  test("multiple values produce correct mean and stddev", () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    let state = WELFORD_INITIAL;
    for (const v of values) {
      state = welfordUpdate(state, v);
    }
    expect(state.count).toBe(8);
    expect(state.mean).toBe(5);
    // Population variance = 4, stddev = 2
    expect(welfordVariance(state)).toBeCloseTo(4, 10);
    expect(welfordStddev(state)).toBeCloseTo(2, 10);
  });

  test("returns immutable new state on each update", () => {
    const s1 = welfordUpdate(WELFORD_INITIAL, 10);
    const s2 = welfordUpdate(s1, 20);
    // s1 should be unchanged
    expect(s1.count).toBe(1);
    expect(s1.mean).toBe(10);
    expect(s2.count).toBe(2);
    expect(s2.mean).toBe(15);
  });
});

describe("welfordVariance", () => {
  test("returns 0 for empty state", () => {
    expect(welfordVariance(WELFORD_INITIAL)).toBe(0);
  });

  test("returns 0 for single sample", () => {
    const state = welfordUpdate(WELFORD_INITIAL, 100);
    expect(welfordVariance(state)).toBe(0);
  });
});

describe("welfordStddev", () => {
  test("returns 0 for empty state", () => {
    expect(welfordStddev(WELFORD_INITIAL)).toBe(0);
  });

  test("returns 0 for single sample", () => {
    const state = welfordUpdate(WELFORD_INITIAL, 100);
    expect(welfordStddev(state)).toBe(0);
  });
});

describe("numerical stability", () => {
  test("handles large values without catastrophic cancellation", () => {
    const base = 1_000_000;
    const values = [base + 1, base + 2, base + 3, base + 4, base + 5];
    let state = WELFORD_INITIAL;
    for (const v of values) {
      state = welfordUpdate(state, v);
    }
    expect(state.mean).toBeCloseTo(base + 3, 10);
    // Population variance of [1,2,3,4,5] = 2, stddev = sqrt(2)
    expect(welfordVariance(state)).toBeCloseTo(2, 10);
    expect(welfordStddev(state)).toBeCloseTo(Math.sqrt(2), 10);
  });

  test("handles negative values correctly", () => {
    const values = [-3, -1, 1, 3];
    let state = WELFORD_INITIAL;
    for (const v of values) {
      state = welfordUpdate(state, v);
    }
    expect(state.mean).toBeCloseTo(0, 10);
    // Population variance of [-3,-1,1,3] = 5, stddev = sqrt(5)
    expect(welfordVariance(state)).toBeCloseTo(5, 10);
    expect(welfordStddev(state)).toBeCloseTo(Math.sqrt(5), 10);
  });
});
