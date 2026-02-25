import { describe, expect, test } from "bun:test";
import { formatCiReport, formatSummaryTable } from "./reporter.js";
import type { EvalRun, EvalSummary, RegressionResult } from "./types.js";

function makeSummary(overrides: Partial<EvalSummary> = {}): EvalSummary {
  return {
    taskCount: 2,
    trialCount: 4,
    passRate: 0.75,
    passAtK: 0.9,
    passToTheK: 0.5,
    meanScore: 0.8,
    latencyP50Ms: 100,
    latencyP95Ms: 250,
    totalCostUsd: 0.05,
    byTask: [
      {
        taskId: "t1",
        taskName: "Task One",
        passRate: 1.0,
        passAtK: 1.0,
        passToTheK: 1.0,
        meanScore: 0.9,
        trials: 2,
      },
      {
        taskId: "t2",
        taskName: "Task Two",
        passRate: 0.5,
        passAtK: 0.75,
        passToTheK: 0.25,
        meanScore: 0.7,
        trials: 2,
      },
    ],
    ...overrides,
  };
}

function makeRun(summary: EvalSummary): EvalRun {
  return {
    id: "run-001",
    name: "test-eval",
    timestamp: "2024-01-01T00:00:00.000Z",
    config: {
      name: "test-eval",
      concurrency: 5,
      timeoutMs: 60_000,
      passThreshold: 0.5,
      taskCount: 2,
    },
    trials: [],
    summary,
  };
}

describe("formatSummaryTable", () => {
  test("includes key metrics", () => {
    const summary = makeSummary();
    const table = formatSummaryTable(summary);

    expect(table).toContain("Eval Summary");
    expect(table).toContain("Tasks: 2");
    expect(table).toContain("Trials: 4");
    expect(table).toContain("75.0%");
    expect(table).toContain("0.80");
    expect(table).toContain("P50: 100ms");
    expect(table).toContain("P95: 250ms");
  });

  test("includes per-task rows", () => {
    const table = formatSummaryTable(makeSummary());
    expect(table).toContain("Task One");
    expect(table).toContain("Task Two");
  });

  test("handles empty byTask", () => {
    const table = formatSummaryTable(makeSummary({ byTask: [] }));
    expect(table).toContain("Tasks: 2");
    expect(table).not.toContain("Task One");
  });
});

describe("formatCiReport", () => {
  test("returns exitCode 0 when no regression", () => {
    const run = makeRun(makeSummary());
    const report = formatCiReport(run);
    expect(report.exitCode).toBe(0);
  });

  test("returns exitCode 1 when regression detected", () => {
    const run = makeRun(makeSummary());
    const regression: RegressionResult = {
      kind: "fail",
      regressions: [
        {
          taskId: "*",
          metric: "passRate",
          baseline: 0.9,
          current: 0.75,
          delta: -0.15,
        },
      ],
      baseline: makeSummary({ passRate: 0.9 }),
      current: makeSummary(),
    };

    const report = formatCiReport(run, regression);
    expect(report.exitCode).toBe(1);
    expect(report.summary).toContain("REGRESSIONS DETECTED");
    expect(report.summary).toContain("passRate");
  });

  test("produces valid JSON", () => {
    const run = makeRun(makeSummary());
    const report = formatCiReport(run);
    const parsed = JSON.parse(report.json);
    expect(parsed.runId).toBe("run-001");
    expect(parsed.summary.passRate).toBe(0.75);
  });

  test("includes regression details in JSON", () => {
    const regression: RegressionResult = {
      kind: "fail",
      regressions: [
        {
          taskId: "t1",
          metric: "passRate",
          baseline: 1,
          current: 0.5,
          delta: -0.5,
        },
      ],
      baseline: makeSummary(),
      current: makeSummary(),
    };
    const report = formatCiReport(makeRun(makeSummary()), regression);
    const parsed = JSON.parse(report.json);
    expect(parsed.regression.kind).toBe("fail");
    expect(parsed.regression.regressions).toHaveLength(1);
  });

  test("handles pass regression result", () => {
    const regression: RegressionResult = {
      kind: "pass",
      baseline: makeSummary(),
      current: makeSummary(),
    };
    const report = formatCiReport(makeRun(makeSummary()), regression);
    expect(report.exitCode).toBe(0);
    expect(report.summary).not.toContain("REGRESSIONS");
  });
});
