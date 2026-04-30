import type { EngineEvent, EngineMetrics } from "@koi/core";
import {
  type AgentHandle,
  EVAL_DEFAULTS,
  type EvalRun,
  type EvalRunConfig,
  type EvalRunConfigSnapshot,
  type EvalScore,
  type EvalSummary,
  type EvalTask,
  type EvalTrial,
  type TaskSummary,
} from "./types.js";

const EMPTY_METRICS: EngineMetrics = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
  durationMs: 0,
};

export async function runEval(config: EvalRunConfig): Promise<EvalRun> {
  validateRunConfig(config);
  const now = config.now ?? defaultNow;
  const idGen = config.idGen ?? defaultIdGen;
  const timeoutMs = config.timeoutMs ?? EVAL_DEFAULTS.TIMEOUT_MS;
  const passThreshold = config.passThreshold ?? EVAL_DEFAULTS.PASS_THRESHOLD;

  const trials: EvalTrial[] = [];
  for (const task of config.tasks) {
    const trialCount = task.trialCount ?? EVAL_DEFAULTS.TRIAL_COUNT;
    const taskTimeout = task.timeoutMs ?? timeoutMs;
    for (let i = 0; i < trialCount; i++) {
      const trial = await runTrial(task, i, config, taskTimeout, passThreshold, now);
      trials.push(trial);
      config.onTrialComplete?.(trial);
    }
  }

  const snapshot: EvalRunConfigSnapshot = {
    name: config.name,
    timeoutMs,
    passThreshold,
    taskCount: config.tasks.length,
  };
  const summary = summarize(config.tasks, trials);
  return {
    id: idGen(),
    name: config.name,
    timestamp: new Date(now()).toISOString(),
    config: snapshot,
    trials,
    summary,
  };
}

function validateRunConfig(config: EvalRunConfig): void {
  if (config.name.length === 0) throw new Error("EvalRunConfig.name must be non-empty");
  if (config.tasks.length === 0) throw new Error("EvalRunConfig.tasks must be non-empty");
  for (const task of config.tasks) {
    if (task.graders.length === 0) throw new Error(`EvalTask "${task.id}" has no graders`);
  }
}

async function runTrial(
  task: EvalTask,
  trialIndex: number,
  config: EvalRunConfig,
  timeoutMs: number,
  passThreshold: number,
  now: () => number,
): Promise<EvalTrial> {
  const start = now();
  const transcript: EngineEvent[] = [];
  let agent: AgentHandle | undefined;
  try {
    agent = await config.agentFactory();
    await collectTranscriptWithTimeout(agent, task, transcript, timeoutMs);
  } catch (e: unknown) {
    return {
      taskId: task.id,
      trialIndex,
      transcript,
      scores: [],
      metrics: { ...EMPTY_METRICS, durationMs: now() - start },
      status: "error",
      error: errorMessage(e),
    };
  } finally {
    await disposeSafely(agent);
  }
  const metrics: EngineMetrics = { ...EMPTY_METRICS, durationMs: now() - start };
  const scores = await gradeAll(task, transcript, metrics);
  const status = scores.every((s) => s.pass && s.score >= passThreshold) ? "pass" : "fail";
  return { taskId: task.id, trialIndex, transcript, scores, metrics, status };
}

async function collectTranscriptWithTimeout(
  agent: AgentHandle,
  task: EvalTask,
  transcript: EngineEvent[],
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("timeout"));
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  const inputWithSignal = { ...task.input, signal: controller.signal };
  const iterator = agent.stream(inputWithSignal)[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), timeoutPromise]);
      if (next.done) return;
      transcript.push(next.value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (controller.signal.aborted) {
      // Fire-and-forget teardown: a non-cooperative agent may keep its own
      // pending awaits alive, so we cannot block on iterator.return() here.
      iterator.return?.(undefined).catch(() => {
        // best-effort teardown — agent may already be broken
      });
    }
  }
}

async function gradeAll(
  task: EvalTask,
  transcript: readonly EngineEvent[],
  metrics: EngineMetrics,
): Promise<readonly EvalScore[]> {
  const out: EvalScore[] = [];
  for (const grader of task.graders) {
    out.push(await safeGrade(grader.id, () => grader.grade(transcript, task.expected, metrics)));
  }
  return out;
}

async function safeGrade(
  graderId: string,
  fn: () => EvalScore | Promise<EvalScore>,
): Promise<EvalScore> {
  try {
    return await fn();
  } catch (e: unknown) {
    return { graderId, score: 0, pass: false, reasoning: errorMessage(e) };
  }
}

async function disposeSafely(agent: AgentHandle | undefined): Promise<void> {
  if (agent?.dispose === undefined) return;
  try {
    await agent.dispose();
  } catch {
    // dispose failures are non-fatal — eval results still valid
  }
}

function summarize(tasks: readonly EvalTask[], trials: readonly EvalTrial[]): EvalSummary {
  const trialCount = trials.length;
  const passed = trials.filter((t) => t.status === "pass").length;
  const errors = trials.filter((t) => t.status === "error").length;
  const meanScore = trialCount === 0 ? 0 : sumScores(trials) / trialCount;
  const passRate = trialCount === 0 ? 0 : passed / trialCount;
  return {
    taskCount: tasks.length,
    trialCount,
    passRate,
    meanScore,
    errorCount: errors,
    byTask: tasks.map((task) => taskSummary(task, trials)),
  };
}

function taskSummary(task: EvalTask, trials: readonly EvalTrial[]): TaskSummary {
  const taskTrials = trials.filter((t) => t.taskId === task.id);
  const passed = taskTrials.filter((t) => t.status === "pass").length;
  const meanScore = taskTrials.length === 0 ? 0 : sumScores(taskTrials) / taskTrials.length;
  return {
    taskId: task.id,
    taskName: task.name,
    passRate: taskTrials.length === 0 ? 0 : passed / taskTrials.length,
    meanScore,
    trials: taskTrials.length,
  };
}

function sumScores(trials: readonly EvalTrial[]): number {
  let total = 0;
  for (const t of trials) {
    if (t.scores.length === 0) continue;
    let s = 0;
    for (const sc of t.scores) s += sc.score;
    total += s / t.scores.length;
  }
  return total;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function defaultNow(): number {
  return Date.now();
}

function defaultIdGen(): string {
  return crypto.randomUUID();
}
