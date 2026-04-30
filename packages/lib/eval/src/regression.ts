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
  // Untrustworthy baselines: a previous run that aborted or had any trial
  // with unconfirmed cancellation may have leaked work or stopped before
  // exercising the full suite. Comparing against it produces meaningless
  // numbers — force the caller to rebaseline.
  if (baseline.aborted === true) {
    return {
      kind: "fail",
      regressions: [
        {
          taskId: "__baseline_aborted__",
          metric: "passRate",
          baseline: 0,
          current: 0,
          delta: 0,
        },
      ],
      baseline: baseline.summary,
      current: current.summary,
    };
  }
  for (const trial of baseline.trials) {
    if (trial.cancellation === "unconfirmed") {
      return {
        kind: "fail",
        regressions: [
          {
            taskId: trial.taskId,
            metric: "passRate",
            baseline: 0,
            current: 0,
            delta: 0,
          },
        ],
        baseline: baseline.summary,
        current: current.summary,
      };
    }
  }
  const passRateDelta = thresholds.passRateDelta ?? EVAL_DEFAULTS.PASS_RATE_DELTA;
  const scoreDelta = thresholds.scoreDelta ?? EVAL_DEFAULTS.SCORE_DELTA;
  // Run-level comparability: if the baseline and current runs were graded
  // under different rules (passThreshold, default timeoutMs), the per-trial
  // pass/fail labels are not directly comparable. Fail closed and force
  // rebaselining rather than reporting a misleading "pass".
  const runLevelDrift = collectRunLevelDrift(baseline, current);
  const regressions = collectRegressions(
    baseline.summary,
    current.summary,
    passRateDelta,
    scoreDelta,
  );
  // Fail-closed regression gate: an aborted run, or any trial with
  // unconfirmed cancellation, means isolation could not be guaranteed.
  // Score-based "pass" is not trustworthy under those conditions, so
  // surface them as regressions regardless of summary numbers.
  if (current.aborted === true) {
    regressions.push({
      taskId: "__run__",
      metric: "passRate",
      baseline: 1,
      current: 0,
      delta: -1,
    });
  }
  for (const trial of current.trials) {
    if (trial.cancellation === "unconfirmed") {
      regressions.push({
        taskId: trial.taskId,
        metric: "passRate",
        baseline: 1,
        current: 0,
        delta: -1,
      });
      break;
    }
  }
  const all = [...runLevelDrift, ...regressions];
  if (all.length === 0) {
    return { kind: "pass", baseline: baseline.summary, current: current.summary };
  }
  return {
    kind: "fail",
    regressions: dedupeRegressions(all),
    baseline: baseline.summary,
    current: current.summary,
  };
}

function collectRunLevelDrift(baseline: EvalRun, current: EvalRun): RegressionDetail[] {
  const out: RegressionDetail[] = [];
  if (baseline.config.passThreshold !== current.config.passThreshold) {
    out.push({
      taskId: "__run__",
      metric: "passRate",
      baseline: baseline.config.passThreshold,
      current: current.config.passThreshold,
      delta: current.config.passThreshold - baseline.config.passThreshold,
    });
  }
  if (baseline.config.timeoutMs !== current.config.timeoutMs) {
    out.push({
      taskId: "__run_timeout__",
      metric: "passRate",
      baseline: baseline.config.timeoutMs,
      current: current.config.timeoutMs,
      delta: current.config.timeoutMs - baseline.config.timeoutMs,
    });
  }
  return out;
}

function dedupeRegressions(regressions: readonly RegressionDetail[]): readonly RegressionDetail[] {
  const seen = new Set<string>();
  const out: RegressionDetail[] = [];
  for (const r of regressions) {
    const key = `${r.taskId}:${r.metric}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function collectRegressions(
  baseline: EvalSummary,
  current: EvalSummary,
  passRateDelta: number,
  scoreDelta: number,
): RegressionDetail[] {
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
  const currentIds = new Set(current.byTask.map((t) => t.taskId));
  for (const cur of current.byTask) {
    const base = baselineByTask.get(cur.taskId);
    if (base === undefined) {
      // New task added to the suite. Hold to a strict perfect bar: the
      // regression delta is for tasks with an established baseline. A
      // brand-new eval has no track record, so allowing slack against an
      // assumed-perfect baseline lets degraded coverage enter the suite
      // and immediately compare clean.
      if (cur.passRate < 1) {
        out.push({
          taskId: cur.taskId,
          metric: "passRate",
          baseline: 1,
          current: cur.passRate,
          delta: cur.passRate - 1,
        });
      }
      if (cur.meanScore < 1) {
        out.push({
          taskId: cur.taskId,
          metric: "meanScore",
          baseline: 1,
          current: cur.meanScore,
          delta: cur.meanScore - 1,
        });
      }
      continue;
    }
    // Fingerprint drift: a reused taskId with changed input/expected/graders
    // means the two runs measure different things. Surfacing the numeric
    // delta would be misleading; flag as a regression and skip the value
    // comparison so the gate forces an explicit baseline rebaseline.
    if (base.taskFingerprint !== cur.taskFingerprint) {
      out.push({
        taskId: cur.taskId,
        metric: "passRate",
        baseline: base.passRate,
        current: cur.passRate,
        delta: cur.passRate - base.passRate,
      });
      continue;
    }
    pushIfRegressed(out, cur.taskId, "passRate", base.passRate, cur.passRate, passRateDelta);
    pushIfRegressed(out, cur.taskId, "meanScore", base.meanScore, cur.meanScore, scoreDelta);
  }
  // Treat removed baseline tasks as regressions — silent task removal
  // would otherwise mask failures by shrinking the suite.
  for (const base of baseline.byTask) {
    if (currentIds.has(base.taskId)) continue;
    out.push({
      taskId: base.taskId,
      metric: "passRate",
      baseline: base.passRate,
      current: 0,
      delta: -base.passRate,
    });
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
