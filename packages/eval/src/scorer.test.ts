import { describe, expect, test } from "bun:test";
import type { EngineMetrics } from "@koi/core";
import { computePassAtK, computePassToTheK, computePercentile, computeSummary } from "./scorer.js";
import type { EvalTask, EvalTrial } from "./types.js";

const ZERO_METRICS: EngineMetrics = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
  durationMs: 100,
};

function makeTrial(
  taskId: string,
  index: number,
  status: "pass" | "fail" | "error",
  score: number,
): EvalTrial {
  return {
    taskId,
    trialIndex: index,
    transcript: [],
    scores: [{ graderId: "test", score, pass: status === "pass" }],
    metrics: ZERO_METRICS,
    status,
  };
}

describe("computePassAtK", () => {
  test("returns 1 when all pass", () => {
    expect(computePassAtK([true, true, true], 3)).toBe(1);
  });

  test("returns 0 when all fail", () => {
    expect(computePassAtK([false, false, false], 3)).toBe(0);
  });

  test("returns 0 for empty results", () => {
    expect(computePassAtK([], 1)).toBe(0);
  });

  test("is always in [0, 1]", () => {
    const cases = [[true, false, true, false], [true], [false], [true, true, false]];
    for (const results of cases) {
      for (const k of [1, 2, 3, 5]) {
        const value = computePassAtK(results, k);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  test("pass@1 equals pass rate for single-sample", () => {
    const results = [true, false, true, true];
    const passRate = results.filter(Boolean).length / results.length;
    expect(computePassAtK(results, 1)).toBeCloseTo(passRate, 5);
  });

  test("pass@k increases with k", () => {
    const results = [true, false, true, false, false];
    const at1 = computePassAtK(results, 1);
    const at2 = computePassAtK(results, 2);
    const at3 = computePassAtK(results, 3);
    expect(at2).toBeGreaterThanOrEqual(at1);
    expect(at3).toBeGreaterThanOrEqual(at2);
  });
});

describe("computePassToTheK", () => {
  test("returns 1 when all pass and k=1", () => {
    expect(computePassToTheK([true, true, true], 1)).toBe(1);
  });

  test("returns 0 when all fail", () => {
    expect(computePassToTheK([false, false], 1)).toBe(0);
  });

  test("returns 0 for empty results", () => {
    expect(computePassToTheK([], 1)).toBe(0);
  });

  test("is always in [0, 1]", () => {
    const results = [true, false, true];
    for (const k of [1, 2, 3, 5]) {
      const value = computePassToTheK(results, k);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  test("pass^k decreases with k for non-perfect results", () => {
    const results = [true, true, false, true];
    const k1 = computePassToTheK(results, 1);
    const k2 = computePassToTheK(results, 2);
    const k3 = computePassToTheK(results, 3);
    expect(k2).toBeLessThanOrEqual(k1);
    expect(k3).toBeLessThanOrEqual(k2);
  });
});

describe("passAtK >= passToTheK", () => {
  test("holds for various inputs", () => {
    const testCases: readonly (readonly boolean[])[] = [
      [true, false, true],
      [true, true, true],
      [false, false, false],
      [true, false],
      [true],
    ];

    for (const results of testCases) {
      for (const k of [1, 2, 3]) {
        const atK = computePassAtK(results, k);
        const toTheK = computePassToTheK(results, k);
        expect(atK).toBeGreaterThanOrEqual(toTheK - 0.001);
      }
    }
  });
});

describe("computePercentile", () => {
  test("returns median for p50", () => {
    expect(computePercentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  test("returns 0 for empty array", () => {
    expect(computePercentile([], 50)).toBe(0);
  });

  test("returns min for p0", () => {
    expect(computePercentile([10, 20, 30], 0)).toBe(10);
  });

  test("returns max for p100", () => {
    expect(computePercentile([10, 20, 30], 100)).toBe(30);
  });

  test("interpolates between values", () => {
    const p75 = computePercentile([1, 2, 3, 4], 75);
    expect(p75).toBeCloseTo(3.25, 5);
  });
});

describe("computeSummary", () => {
  test("computes summary for multiple tasks", () => {
    const tasks: readonly EvalTask[] = [
      {
        id: "t1",
        name: "Task 1",
        input: { kind: "text", text: "test" },
        graders: [],
      },
      {
        id: "t2",
        name: "Task 2",
        input: { kind: "text", text: "test" },
        graders: [],
      },
    ];

    const trials: readonly EvalTrial[] = [
      makeTrial("t1", 0, "pass", 1),
      makeTrial("t1", 1, "fail", 0),
      makeTrial("t2", 0, "pass", 0.8),
    ];

    const summary = computeSummary(trials, tasks);
    expect(summary.taskCount).toBe(2);
    expect(summary.trialCount).toBe(3);
    expect(summary.passRate).toBeCloseTo(2 / 3, 5);
    expect(summary.byTask).toHaveLength(2);
  });

  test("handles empty trials", () => {
    const summary = computeSummary([], []);
    expect(summary.taskCount).toBe(0);
    expect(summary.trialCount).toBe(0);
    expect(summary.passRate).toBe(0);
    expect(summary.meanScore).toBe(0);
  });
});
