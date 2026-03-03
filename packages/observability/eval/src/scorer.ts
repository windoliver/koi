/**
 * Scoring aggregation — pass@k, pass^k, percentiles, summary computation.
 */

import type { EvalSummary, EvalTask, EvalTrial, TaskSummary } from "./types.js";

/**
 * Computes a full EvalSummary from trial results and task definitions.
 */
export function computeSummary(
  trials: readonly EvalTrial[],
  tasks: readonly EvalTask[],
): EvalSummary {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const trialsByTask = groupBy(trials, (t) => t.taskId);
  const byTask = computeTaskSummaries(trialsByTask, taskMap);

  const allPassResults = trials.map((t) => t.status === "pass");
  const allScores = trials.flatMap((t) => t.scores.map((s) => s.score));
  const allLatencies = trials.map((t) => t.metrics.durationMs);
  const maxK = Math.max(...tasks.map((t) => t.trialCount ?? 1), 1);

  return {
    taskCount: tasks.length,
    trialCount: trials.length,
    passRate: mean(allPassResults.map((p) => (p ? 1 : 0))),
    passAtK: computePassAtK(allPassResults, maxK),
    passToTheK: computePassToTheK(allPassResults, maxK),
    meanScore: mean(allScores),
    latencyP50Ms: computePercentile(allLatencies, 50),
    latencyP95Ms: computePercentile(allLatencies, 95),
    totalCostUsd: 0,
    byTask,
  };
}

function computeTaskSummaries(
  trialsByTask: Map<string, EvalTrial[]>,
  taskMap: Map<string, EvalTask>,
): readonly TaskSummary[] {
  const result: TaskSummary[] = [];
  for (const [taskId, taskTrials] of trialsByTask.entries()) {
    const task = taskMap.get(taskId);
    const k = task?.trialCount ?? 1;
    const passResults = taskTrials.map((t) => t.status === "pass");
    const scores = taskTrials.flatMap((t) => t.scores.map((s) => s.score));

    result.push({
      taskId,
      taskName: task?.name ?? taskId,
      passRate: passResults.filter(Boolean).length / passResults.length,
      passAtK: computePassAtK(passResults, k),
      passToTheK: computePassToTheK(passResults, k),
      meanScore: mean(scores),
      trials: taskTrials.length,
    });
  }
  return result;
}

/**
 * pass@k — probability of at least one pass in k samples.
 * Formula: 1 - C(n-c, k) / C(n, k) where n = total, c = passing.
 */
export function computePassAtK(trialResults: readonly boolean[], k: number): number {
  const n = trialResults.length;
  const c = trialResults.filter(Boolean).length;

  if (n === 0 || k <= 0) return 0;
  if (c === n) return 1;
  if (c === 0) return 0;
  if (k > n) return c > 0 ? 1 : 0;

  const logNumerator = logCombination(n - c, k);
  const logDenominator = logCombination(n, k);

  if (logNumerator === -Infinity) return 1;
  if (logDenominator === -Infinity) return 0;

  return 1 - Math.exp(logNumerator - logDenominator);
}

/**
 * pass^k — probability of all k trials passing. Measures consistency.
 * Formula: (c/n)^k
 */
export function computePassToTheK(trialResults: readonly boolean[], k: number): number {
  const n = trialResults.length;
  const c = trialResults.filter(Boolean).length;
  if (n === 0 || k <= 0) return 0;
  return (c / n) ** k;
}

/**
 * Computes a percentile value from a sorted array of numbers.
 */
export function computePercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const fraction = index - lower;
  const lowerVal = sorted[lower] ?? 0;
  const upperVal = sorted[upper] ?? lowerVal;
  return lowerVal + fraction * (upperVal - lowerVal);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function logCombination(n: number, k: number): number {
  if (k > n) return -Infinity;
  if (k === 0 || k === n) return 0;
  // let justified: accumulating log sum
  let logResult = 0;
  const effectiveK = Math.min(k, n - k);
  for (let i = 0; i < effectiveK; i++) {
    logResult += Math.log(n - i) - Math.log(i + 1);
  }
  return logResult;
}

function groupBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const existing = map.get(key);
    if (existing !== undefined) {
      existing.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}
