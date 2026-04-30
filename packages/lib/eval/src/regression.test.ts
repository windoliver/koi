import { describe, expect, test } from "bun:test";
import { compareRuns } from "./regression.js";
import type { EvalRun, EvalSummary } from "./types.js";

const summary = (
  passRate: number,
  meanScore: number,
  byTask: EvalSummary["byTask"] = [],
): EvalSummary => ({
  taskCount: byTask.length || 1,
  trialCount: 1,
  passRate,
  meanScore,
  errorCount: 0,
  byTask,
});

const run = (id: string, summaryArg: EvalSummary): EvalRun => ({
  id,
  name: "r",
  timestamp: "2026-01-01T00:00:00.000Z",
  config: { name: "r", timeoutMs: 60_000, passThreshold: 0.5, taskCount: 1 },
  trials: [],
  summary: summaryArg,
});

describe("compareRuns", () => {
  test("returns no_baseline when baseline is undefined", () => {
    expect(compareRuns(undefined, run("c", summary(1, 1))).kind).toBe("no_baseline");
  });

  test("passes when within thresholds", () => {
    const baseline = run("b", summary(1, 1));
    const current = run("c", summary(0.96, 0.95));
    expect(compareRuns(baseline, current).kind).toBe("pass");
  });

  test("fails on overall pass-rate drop", () => {
    const baseline = run("b", summary(1, 1));
    const current = run("c", summary(0.5, 1));
    const result = compareRuns(baseline, current);
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.regressions.some((r) => r.metric === "passRate")).toBe(true);
    }
  });

  test("fails on per-task score drop", () => {
    const baselineByTask = [
      { taskId: "t1", taskName: "t1", passRate: 1, meanScore: 1, trials: 1, taskFingerprint: "fp" },
    ];
    const currentByTask = [
      {
        taskId: "t1",
        taskName: "t1",
        passRate: 1,
        meanScore: 0.5,
        trials: 1,
        taskFingerprint: "fp",
      },
    ];
    const result = compareRuns(
      run("b", summary(1, 1, baselineByTask)),
      run("c", summary(1, 0.7, currentByTask)),
    );
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.regressions.some((r) => r.taskId === "t1")).toBe(true);
    }
  });

  test("flags removed baseline task as regression", () => {
    const baselineByTask = [
      { taskId: "t1", taskName: "t1", passRate: 1, meanScore: 1, trials: 1, taskFingerprint: "f1" },
      { taskId: "t2", taskName: "t2", passRate: 1, meanScore: 1, trials: 1, taskFingerprint: "f2" },
    ];
    const currentByTask = [
      { taskId: "t1", taskName: "t1", passRate: 1, meanScore: 1, trials: 1, taskFingerprint: "f1" },
    ];
    const result = compareRuns(
      run("b", summary(1, 1, baselineByTask)),
      run("c", summary(1, 1, currentByTask)),
    );
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.regressions.some((r) => r.taskId === "t2")).toBe(true);
    }
  });

  test("flags new task with low mean score even if pass rate is 100%", () => {
    const baselineByTask = [
      { taskId: "t1", taskName: "t1", passRate: 1, meanScore: 1, trials: 1, taskFingerprint: "f1" },
    ];
    const currentByTask = [
      { taskId: "t1", taskName: "t1", passRate: 1, meanScore: 1, trials: 1, taskFingerprint: "f1" },
      {
        taskId: "t2-new",
        taskName: "t2-new",
        passRate: 1,
        meanScore: 0.6,
        trials: 1,
        taskFingerprint: "f2",
      },
    ];
    const result = compareRuns(
      run("b", summary(1, 1, baselineByTask)),
      run("c", summary(1, 0.8, currentByTask)),
    );
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(
        result.regressions.some((r) => r.taskId === "t2-new" && r.metric === "meanScore"),
      ).toBe(true);
    }
  });

  test("aborted current run is treated as a regression", () => {
    const baseline = run("b", summary(1, 1));
    const current = { ...run("c", summary(1, 1)), aborted: true as const };
    const result = compareRuns(baseline, current);
    expect(result.kind).toBe("fail");
  });

  test("unconfirmed cancellation in any trial is a regression", () => {
    const baseline = run("b", summary(1, 1));
    const current = {
      ...run("c", summary(1, 1)),
      trials: [
        {
          taskId: "t1",
          trialIndex: 0,
          transcript: [],
          scores: [],
          metrics: {
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            turns: 0,
            durationMs: 0,
          },
          status: "pass" as const,
          cancellation: "unconfirmed" as const,
        },
      ],
    };
    const result = compareRuns(baseline, current);
    expect(result.kind).toBe("fail");
  });

  test("flags fingerprint drift on reused taskId", () => {
    const baselineByTask = [
      { taskId: "t1", taskName: "t1", passRate: 1, meanScore: 1, trials: 1, taskFingerprint: "v1" },
    ];
    // Same numbers, different fingerprint = task definition drifted under
    // a reused id. The gate must refuse the comparison instead of treating
    // the runs as equivalent.
    const currentByTask = [
      { taskId: "t1", taskName: "t1", passRate: 1, meanScore: 1, trials: 1, taskFingerprint: "v2" },
    ];
    const result = compareRuns(
      run("b", summary(1, 1, baselineByTask)),
      run("c", summary(1, 1, currentByTask)),
    );
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.regressions.some((r) => r.taskId === "t1")).toBe(true);
    }
  });

  test("fails closed when run-level passThreshold drifted", () => {
    const baseline = run("b", summary(1, 1));
    const current: EvalRun = {
      ...run("c", summary(1, 1)),
      config: { name: "r", timeoutMs: 60_000, passThreshold: 0.1, taskCount: 1 },
    };
    expect(compareRuns(baseline, current).kind).toBe("fail");
  });

  test("fails closed when run-level default timeoutMs drifted", () => {
    const baseline = run("b", summary(1, 1));
    const current: EvalRun = {
      ...run("c", summary(1, 1)),
      config: { name: "r", timeoutMs: 1_000, passThreshold: 0.5, taskCount: 1 },
    };
    expect(compareRuns(baseline, current).kind).toBe("fail");
  });

  test("respects custom thresholds", () => {
    const baseline = run("b", summary(1, 1));
    const current = run("c", summary(0.5, 1));
    const result = compareRuns(baseline, current, { passRateDelta: 0.6 });
    expect(result.kind).toBe("pass");
  });
});
