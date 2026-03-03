/**
 * Reporter — CI-friendly output formatting.
 */

import type { CiReport, EvalRun, EvalSummary, RegressionResult } from "./types.js";

/**
 * Formats a summary as an ASCII table for human reading.
 */
export function formatSummaryTable(summary: EvalSummary): string {
  const lines: string[] = [];

  lines.push("Eval Summary");
  lines.push("=".repeat(60));
  lines.push(`Tasks: ${String(summary.taskCount)}  Trials: ${String(summary.trialCount)}`);
  lines.push(
    `Pass Rate: ${formatPercent(summary.passRate)}  Mean Score: ${summary.meanScore.toFixed(2)}`,
  );
  lines.push(
    `pass@k: ${formatPercent(summary.passAtK)}  pass^k: ${formatPercent(summary.passToTheK)}`,
  );
  lines.push(
    `Latency P50: ${String(Math.round(summary.latencyP50Ms))}ms  P95: ${String(Math.round(summary.latencyP95Ms))}ms`,
  );
  lines.push(`Total Cost: $${summary.totalCostUsd.toFixed(4)}`);

  if (summary.byTask.length > 0) {
    lines.push("");
    lines.push(`${padRight("Task", 30)}${padRight("Pass%", 10)}${padRight("Score", 10)}Trials`);
    lines.push("-".repeat(60));

    for (const task of summary.byTask) {
      lines.push(
        padRight(truncate(task.taskName, 28), 30) +
          padRight(formatPercent(task.passRate), 10) +
          padRight(task.meanScore.toFixed(2), 10) +
          String(task.trials),
      );
    }
  }

  return lines.join("\n");
}

/**
 * Formats a CI report with exit code, JSON output, and human summary.
 */
export function formatCiReport(run: EvalRun, regression?: RegressionResult): CiReport {
  const hasRegression = regression?.kind === "fail";
  const exitCode = hasRegression ? 1 : 0;

  const jsonData = {
    runId: run.id,
    name: run.name,
    timestamp: run.timestamp,
    summary: run.summary,
    regression:
      regression !== undefined
        ? {
            kind: regression.kind,
            regressions: regression.kind === "fail" ? regression.regressions : [],
          }
        : undefined,
  };

  const summaryLines: string[] = [];
  summaryLines.push(formatSummaryTable(run.summary));

  if (hasRegression) {
    summaryLines.push("");
    summaryLines.push("REGRESSIONS DETECTED:");
    for (const r of regression.regressions) {
      const scope = r.taskId === "*" ? "Global" : `Task ${r.taskId}`;
      summaryLines.push(
        `  ${scope} ${r.metric}: ${r.baseline.toFixed(2)} -> ${r.current.toFixed(2)} (delta: ${r.delta.toFixed(2)})`,
      );
    }
  }

  return {
    exitCode,
    json: JSON.stringify(jsonData, null, 2),
    summary: summaryLines.join("\n"),
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function padRight(str: string, length: number): string {
  return str.length >= length ? str : str + " ".repeat(length - str.length);
}

function truncate(str: string, maxLength: number): string {
  return str.length <= maxLength ? str : `${str.slice(0, maxLength - 1)}…`;
}
