import { describe, expect, test } from "bun:test";
import { computeBackoff } from "./backoff.js";

describe("computeBackoff", () => {
  test("output is always >= baseMs", () => {
    for (let i = 0; i < 100; i++) {
      const result = computeBackoff(0, 100, 30_000);
      expect(result).toBeGreaterThanOrEqual(100);
    }
  });

  test("output never exceeds capMs", () => {
    for (let i = 0; i < 100; i++) {
      const result = computeBackoff(100_000, 100, 30_000);
      expect(result).toBeLessThanOrEqual(30_000);
    }
  });

  test("output is never negative", () => {
    for (let i = 0; i < 100; i++) {
      const result = computeBackoff(0, 100, 30_000);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });

  test("grows toward cap with increasing prevSleep", () => {
    // With a large prevSleep, the upper bound should approach capMs
    // Run multiple samples to get a statistical measure
    const smallPrevResults = Array.from({ length: 200 }, () => computeBackoff(100, 100, 30_000));
    const largePrevResults = Array.from({ length: 200 }, () => computeBackoff(10_000, 100, 30_000));

    const smallAvg = smallPrevResults.reduce((a, b) => a + b, 0) / smallPrevResults.length;
    const largeAvg = largePrevResults.reduce((a, b) => a + b, 0) / largePrevResults.length;

    // The average for large prevSleep should be higher
    expect(largeAvg).toBeGreaterThan(smallAvg);
  });

  test("uses default baseMs and capMs when not provided", () => {
    const result = computeBackoff(0);
    expect(result).toBeGreaterThanOrEqual(100);
    expect(result).toBeLessThanOrEqual(30_000);
  });

  test("returns integer values (floor applied)", () => {
    for (let i = 0; i < 50; i++) {
      const result = computeBackoff(500, 100, 30_000);
      expect(result).toBe(Math.floor(result));
    }
  });

  test("handles zero prevSleep (first attempt)", () => {
    const result = computeBackoff(0, 100, 30_000);
    // With prevSleep=0, upper = max(baseMs, 0*3) = baseMs, so result = baseMs
    expect(result).toBe(100);
  });
});
