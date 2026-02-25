/**
 * Regression detection — compares current eval run against a baseline.
 */

import type {
  EvalSummary,
  RegressionDetail,
  RegressionResult,
  RegressionThresholds,
  TaskSummary,
} from "./types.js";

const DEFAULT_PASS_RATE_DELTA = 0.05;
const DEFAULT_SCORE_DELTA = 0.1;
const DEFAULT_LATENCY_MULTIPLIER = 2.0;

/**
 * Compares current summary against baseline, returning regression details.
 */
export function detectRegression(
  baseline: EvalSummary,
  current: EvalSummary,
  thresholds?: RegressionThresholds,
): RegressionResult {
  const passRateDelta = thresholds?.passRateDelta ?? DEFAULT_PASS_RATE_DELTA;
  const scoreDelta = thresholds?.scoreDelta ?? DEFAULT_SCORE_DELTA;
  const latencyMultiplier = thresholds?.latencyMultiplier ?? DEFAULT_LATENCY_MULTIPLIER;

  const regressions = [
    ...checkGlobalRegressions(baseline, current, passRateDelta, scoreDelta, latencyMultiplier),
    ...checkPerTaskRegressions(baseline, current, passRateDelta, scoreDelta),
  ];

  if (regressions.length === 0) {
    return { kind: "pass", baseline, current };
  }
  return { kind: "fail", regressions, baseline, current };
}

function checkGlobalRegressions(
  baseline: EvalSummary,
  current: EvalSummary,
  passRateDelta: number,
  scoreDelta: number,
  latencyMultiplier: number,
): readonly RegressionDetail[] {
  const regressions: RegressionDetail[] = [];

  const passRateDrop = baseline.passRate - current.passRate;
  if (passRateDrop > passRateDelta) {
    regressions.push(
      makeDetail("*", "passRate", baseline.passRate, current.passRate, -passRateDrop),
    );
  }

  const scoreDrop = baseline.meanScore - current.meanScore;
  if (scoreDrop > scoreDelta) {
    regressions.push(
      makeDetail("*", "meanScore", baseline.meanScore, current.meanScore, -scoreDrop),
    );
  }

  if (
    baseline.latencyP95Ms > 0 &&
    current.latencyP95Ms > baseline.latencyP95Ms * latencyMultiplier
  ) {
    const delta = current.latencyP95Ms - baseline.latencyP95Ms;
    regressions.push(
      makeDetail("*", "latencyP95Ms", baseline.latencyP95Ms, current.latencyP95Ms, delta),
    );
  }

  return regressions;
}

function checkPerTaskRegressions(
  baseline: EvalSummary,
  current: EvalSummary,
  passRateDelta: number,
  scoreDelta: number,
): readonly RegressionDetail[] {
  const baselineMap = new Map(baseline.byTask.map((t) => [t.taskId, t]));
  const regressions: RegressionDetail[] = [];

  for (const ct of current.byTask) {
    const bt = baselineMap.get(ct.taskId);
    if (bt === undefined) continue;

    const taskRegs = checkTaskPair(bt, ct, passRateDelta, scoreDelta);
    for (const r of taskRegs) regressions.push(r);
  }
  return regressions;
}

function checkTaskPair(
  bt: TaskSummary,
  ct: TaskSummary,
  passRateDelta: number,
  scoreDelta: number,
): readonly RegressionDetail[] {
  const regressions: RegressionDetail[] = [];
  const passDrop = bt.passRate - ct.passRate;
  if (passDrop > passRateDelta) {
    regressions.push(makeDetail(ct.taskId, "passRate", bt.passRate, ct.passRate, -passDrop));
  }
  const scoreDrop = bt.meanScore - ct.meanScore;
  if (scoreDrop > scoreDelta) {
    regressions.push(makeDetail(ct.taskId, "meanScore", bt.meanScore, ct.meanScore, -scoreDrop));
  }
  return regressions;
}

function makeDetail(
  taskId: string,
  metric: string,
  baseline: number,
  current: number,
  delta: number,
): RegressionDetail {
  return { taskId, metric, baseline, current, delta };
}
