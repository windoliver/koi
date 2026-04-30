import {
  EVAL_DEFAULTS,
  type EvalRun,
  type EvalSummary,
  type RegressionDetail,
  type RegressionResult,
  type RegressionThresholds,
} from "./types.js";

export function compareRuns(
  baseline: EvalRun | undefined,
  current: EvalRun,
  thresholds: RegressionThresholds = {},
): RegressionResult {
  if (baseline === undefined) return { kind: "no_baseline" };
  const passRateDelta = thresholds.passRateDelta ?? EVAL_DEFAULTS.PASS_RATE_DELTA;
  const scoreDelta = thresholds.scoreDelta ?? EVAL_DEFAULTS.SCORE_DELTA;
  const regressions = collectRegressions(
    baseline.summary,
    current.summary,
    passRateDelta,
    scoreDelta,
  );
  if (regressions.length === 0) {
    return { kind: "pass", baseline: baseline.summary, current: current.summary };
  }
  return {
    kind: "fail",
    regressions,
    baseline: baseline.summary,
    current: current.summary,
  };
}

function collectRegressions(
  baseline: EvalSummary,
  current: EvalSummary,
  passRateDelta: number,
  scoreDelta: number,
): readonly RegressionDetail[] {
  const out: RegressionDetail[] = [];
  pushIfRegressed(
    out,
    "__overall__",
    "passRate",
    baseline.passRate,
    current.passRate,
    passRateDelta,
  );
  pushIfRegressed(
    out,
    "__overall__",
    "meanScore",
    baseline.meanScore,
    current.meanScore,
    scoreDelta,
  );

  const baselineByTask = new Map(baseline.byTask.map((t) => [t.taskId, t]));
  for (const cur of current.byTask) {
    const base = baselineByTask.get(cur.taskId);
    if (base === undefined) continue;
    pushIfRegressed(out, cur.taskId, "passRate", base.passRate, cur.passRate, passRateDelta);
    pushIfRegressed(out, cur.taskId, "meanScore", base.meanScore, cur.meanScore, scoreDelta);
  }
  return out;
}

function pushIfRegressed(
  out: RegressionDetail[],
  taskId: string,
  metric: "passRate" | "meanScore",
  baseline: number,
  current: number,
  maxDrop: number,
): void {
  const delta = current - baseline;
  if (delta < -maxDrop) {
    out.push({ taskId, metric, baseline, current, delta });
  }
}
