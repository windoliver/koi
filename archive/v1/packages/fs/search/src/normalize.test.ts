import { describe, expect, test } from "bun:test";
import { normalize, normalizeL2, normalizeMinMax, normalizeZScore } from "./normalize.js";

describe("normalizeMinMax", () => {
  test("returns empty for empty input", () => {
    expect(normalizeMinMax([])).toEqual([]);
  });

  test("normalizes scores to [0, 1]", () => {
    const result = normalizeMinMax([1, 2, 3, 4, 5]);
    expect(result).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  test("returns all 1s when all scores are equal", () => {
    expect(normalizeMinMax([3, 3, 3])).toEqual([1, 1, 1]);
  });

  test("handles single score", () => {
    expect(normalizeMinMax([5])).toEqual([1]);
  });

  test("handles negative scores", () => {
    const result = normalizeMinMax([-2, 0, 2]);
    expect(result).toEqual([0, 0.5, 1]);
  });
});

describe("normalizeZScore", () => {
  test("returns empty for empty input", () => {
    expect(normalizeZScore([])).toEqual([]);
  });

  test("returns all 1s when all scores are equal", () => {
    expect(normalizeZScore([5, 5, 5])).toEqual([1, 1, 1]);
  });

  test("centers scores around 0.5", () => {
    const result = normalizeZScore([1, 2, 3]);
    expect(result[1]).toBeCloseTo(0.5, 5);
  });

  test("clamps to [0, 1]", () => {
    const result = normalizeZScore([0, 0, 0, 0, 100]);
    for (const s of result) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

describe("normalizeL2", () => {
  test("returns empty for empty input", () => {
    expect(normalizeL2([])).toEqual([]);
  });

  test("unit vector has L2 norm of 1", () => {
    const result = normalizeL2([3, 4]);
    expect(result[0]).toBeCloseTo(0.6, 5);
    expect(result[1]).toBeCloseTo(0.8, 5);
    const norm = Math.sqrt(result.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  test("returns zeros when all scores are zero", () => {
    expect(normalizeL2([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe("normalize dispatcher", () => {
  test("dispatches to min_max", () => {
    expect(normalize([1, 2, 3], "min_max")).toEqual(normalizeMinMax([1, 2, 3]));
  });

  test("dispatches to z_score", () => {
    expect(normalize([1, 2, 3], "z_score")).toEqual(normalizeZScore([1, 2, 3]));
  });

  test("dispatches to l2", () => {
    expect(normalize([1, 2, 3], "l2")).toEqual(normalizeL2([1, 2, 3]));
  });
});
