import { describe, expect, test } from "bun:test";
import { computeTrend, sparkline } from "./sparkline.js";

describe("sparkline", () => {
  test("empty array returns empty string", () => {
    expect(sparkline([])).toBe("");
  });

  test("single value returns single character", () => {
    const result = sparkline([42]);
    expect(result).toHaveLength(1);
  });

  test("all same values returns uniform characters", () => {
    const result = sparkline([5, 5, 5, 5]);
    const chars = new Set(result.split(""));
    expect(chars.size).toBe(1);
  });

  test("ascending values produce ascending blocks", () => {
    const result = sparkline([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(result).toBe("▁▂▃▄▅▆▇█");
  });

  test("two values produce min and max chars", () => {
    const result = sparkline([0, 100]);
    expect(result).toBe("▁█");
  });

  test("length matches input length", () => {
    const values = [10, 20, 30, 40, 50];
    expect(sparkline(values)).toHaveLength(5);
  });
});

describe("computeTrend", () => {
  test("returns flat for empty array", () => {
    expect(computeTrend([])).toBe("flat");
  });

  test("returns flat for single value", () => {
    expect(computeTrend([42])).toBe("flat");
  });

  test("returns rising when second half average is higher", () => {
    expect(computeTrend([1, 2, 3, 4, 5, 6])).toBe("rising");
    expect(computeTrend([0.1, 0.2, 0.5, 0.8])).toBe("rising");
  });

  test("returns declining when second half average is lower", () => {
    expect(computeTrend([6, 5, 4, 3, 2, 1])).toBe("declining");
    expect(computeTrend([0.9, 0.7, 0.3, 0.1])).toBe("declining");
  });

  test("returns flat when halves have equal averages", () => {
    expect(computeTrend([5, 5, 5, 5])).toBe("flat");
    expect(computeTrend([3, 7, 7, 3])).toBe("flat");
  });

  test("handles two-element arrays", () => {
    expect(computeTrend([1, 5])).toBe("rising");
    expect(computeTrend([5, 1])).toBe("declining");
    expect(computeTrend([3, 3])).toBe("flat");
  });

  test("handles odd-length arrays (first half is smaller)", () => {
    // [1, 2] vs [3, 4, 5] — first half avg = 1.5, second half avg = 4
    expect(computeTrend([1, 2, 3, 4, 5])).toBe("rising");
  });
});
