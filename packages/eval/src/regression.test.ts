import { describe, expect, test } from "bun:test";
import { detectRegression } from "./regression.js";
import type { EvalSummary } from "./types.js";

function makeSummary(overrides: Partial<EvalSummary> = {}): EvalSummary {
  return {
    taskCount: 1,
    trialCount: 3,
    passRate: 0.8,
    passAtK: 1,
    passToTheK: 0.512,
    meanScore: 0.85,
    latencyP50Ms: 100,
    latencyP95Ms: 200,
    totalCostUsd: 0,
    byTask: [],
    ...overrides,
  };
}

describe("detectRegression", () => {
  test("returns pass when no regression", () => {
    const baseline = makeSummary();
    const current = makeSummary({ passRate: 0.79 });
    const result = detectRegression(baseline, current);
    expect(result.kind).toBe("pass");
  });

  test("detects pass rate regression", () => {
    const baseline = makeSummary({ passRate: 0.9 });
    const current = makeSummary({ passRate: 0.8 });
    const result = detectRegression(baseline, current);
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      const passRateReg = result.regressions.find(
        (r) => r.metric === "passRate" && r.taskId === "*",
      );
      expect(passRateReg).toBeDefined();
      expect(passRateReg?.delta).toBeLessThan(0);
    }
  });

  test("detects mean score regression", () => {
    const baseline = makeSummary({ meanScore: 0.9 });
    const current = makeSummary({ meanScore: 0.7 });
    const result = detectRegression(baseline, current);
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.regressions.some((r) => r.metric === "meanScore")).toBe(true);
    }
  });

  test("detects latency regression", () => {
    const baseline = makeSummary({ latencyP95Ms: 100 });
    const current = makeSummary({ latencyP95Ms: 250 });
    const result = detectRegression(baseline, current);
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.regressions.some((r) => r.metric === "latencyP95Ms")).toBe(true);
    }
  });

  test("detects per-task regression", () => {
    const baseline = makeSummary({
      byTask: [
        {
          taskId: "t1",
          taskName: "Task 1",
          passRate: 1.0,
          passAtK: 1,
          passToTheK: 1,
          meanScore: 0.9,
          trials: 3,
        },
      ],
    });
    const current = makeSummary({
      byTask: [
        {
          taskId: "t1",
          taskName: "Task 1",
          passRate: 0.5,
          passAtK: 1,
          passToTheK: 0.125,
          meanScore: 0.5,
          trials: 3,
        },
      ],
    });
    const result = detectRegression(baseline, current);
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      const taskReg = result.regressions.find((r) => r.taskId === "t1");
      expect(taskReg).toBeDefined();
    }
  });

  test("uses custom thresholds", () => {
    const baseline = makeSummary({ passRate: 0.9 });
    const current = makeSummary({ passRate: 0.8 });

    // With default threshold (0.05), this is a regression
    const strict = detectRegression(baseline, current);
    expect(strict.kind).toBe("fail");

    // With relaxed threshold (0.2), this is not a regression
    const relaxed = detectRegression(baseline, current, {
      passRateDelta: 0.2,
    });
    expect(relaxed.kind).toBe("pass");
  });

  test("ignores latency regression when baseline is 0", () => {
    const baseline = makeSummary({ latencyP95Ms: 0 });
    const current = makeSummary({ latencyP95Ms: 1000 });
    const result = detectRegression(baseline, current);
    // Should not flag latency when baseline is 0
    if (result.kind === "fail") {
      expect(result.regressions.some((r) => r.metric === "latencyP95Ms")).toBe(false);
    }
  });

  test("ignores new tasks not in baseline", () => {
    const baseline = makeSummary({ byTask: [] });
    const current = makeSummary({
      byTask: [
        {
          taskId: "new-task",
          taskName: "New Task",
          passRate: 0,
          passAtK: 0,
          passToTheK: 0,
          meanScore: 0,
          trials: 1,
        },
      ],
    });
    const result = detectRegression(baseline, current);
    if (result.kind === "fail") {
      expect(result.regressions.some((r) => r.taskId === "new-task")).toBe(false);
    }
  });
});
