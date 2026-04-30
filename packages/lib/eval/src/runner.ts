import type { EngineEvent, EngineMetrics } from "@koi/core";
import {
  type AgentHandle,
  type CancellationStatus,
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

  const disposeTimeoutMs = config.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
  const trials: EvalTrial[] = [];
  let aborted = false;
  outer: for (const task of config.tasks) {
    const trialCount = task.trialCount ?? EVAL_DEFAULTS.TRIAL_COUNT;
    const taskTimeout = task.timeoutMs ?? timeoutMs;
    for (let i = 0; i < trialCount; i++) {
      const trial = await runTrial(
        task,
        i,
        config,
        taskTimeout,
        disposeTimeoutMs,
        passThreshold,
        now,
      );
      trials.push(trial);
      config.onTrialComplete?.(trial);
      // Hard isolation guarantee: once teardown of a timed-out agent
      // could not be confirmed, we cannot trust that subsequent trials
      // will run independently — the leaked agent may still be issuing
      // tool calls or mutating shared state. Abort the rest of the run.
      if (trial.cancellation === "unconfirmed") {
        aborted = true;
        break outer;
      }
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
    ...(aborted ? { aborted: true as const, abortReason: "cancellation_unconfirmed" } : {}),
  };
}

function validateRunConfig(config: EvalRunConfig): void {
  if (config.name.length === 0) throw new Error("EvalRunConfig.name must be non-empty");
  if (config.tasks.length === 0) throw new Error("EvalRunConfig.tasks must be non-empty");
  const seenIds = new Set<string>();
  for (const task of config.tasks) {
    if (task.id.length === 0) throw new Error("EvalTask.id must be non-empty");
    if (seenIds.has(task.id)) {
      // Summaries and regression comparison key on taskId; duplicates would
      // merge unrelated tasks into the same bucket and mask failures.
      throw new Error(`EvalRunConfig.tasks: duplicate task id "${task.id}"`);
    }
    seenIds.add(task.id);
    if (task.graders.length === 0) throw new Error(`EvalTask "${task.id}" has no graders`);
  }
}

async function runTrial(
  task: EvalTask,
  trialIndex: number,
  config: EvalRunConfig,
  timeoutMs: number,
  disposeTimeoutMs: number,
  passThreshold: number,
  now: () => number,
): Promise<EvalTrial> {
  const start = now();
  const transcript: EngineEvent[] = [];
  let agent: AgentHandle | undefined;
  let timedOut = false;
  let returnAwaited = false;
  let trialError: unknown;
  try {
    agent = await config.agentFactory();
    await collectTranscriptWithTimeout(agent, task, transcript, timeoutMs);
  } catch (e: unknown) {
    const marker = readTimeoutMarker(e);
    if (marker !== undefined) {
      timedOut = true;
      returnAwaited = marker.returnAwaited;
    }
    trialError = e;
  }
  const disposeAwaited = await disposeSafely(agent, disposeTimeoutMs);
  const cancellation: CancellationStatus = timedOut
    ? returnAwaited && disposeAwaited
      ? "confirmed"
      : "unconfirmed"
    : "n/a";

  const durationMs = now() - start;
  const metrics = mergeMetrics(extractMetrics(transcript), durationMs);
  if (trialError !== undefined) {
    return {
      taskId: task.id,
      trialIndex,
      transcript,
      scores: [],
      metrics,
      status: "error",
      error:
        cancellation === "unconfirmed"
          ? `${errorMessage(trialError)} (cancellation unconfirmed — agent may still be running)`
          : errorMessage(trialError),
      cancellation,
    };
  }

  const scores = await gradeAll(task, transcript, metrics);
  const status = scores.every((s) => s.pass && s.score >= passThreshold) ? "pass" : "fail";
  return { taskId: task.id, trialIndex, transcript, scores, metrics, status, cancellation };
}

/**
 * Pull EngineMetrics from the terminal `done` event so graders and
 * persisted runs can detect token, turn, and cost regressions. Returns
 * undefined if the agent never emitted a `done` event (e.g. timeout).
 */
function extractMetrics(transcript: readonly EngineEvent[]): EngineMetrics | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const ev = transcript[i];
    if (ev?.kind === "done") return ev.output.metrics;
  }
  return undefined;
}

function mergeMetrics(
  fromAgent: EngineMetrics | undefined,
  measuredDurationMs: number,
): EngineMetrics {
  if (fromAgent === undefined) return { ...EMPTY_METRICS, durationMs: measuredDurationMs };
  // Trust the agent's metrics; fall back to wall-clock duration when the
  // adapter didn't report one. Preserve costUsd's optional shape under
  // exactOptionalPropertyTypes.
  return {
    totalTokens: fromAgent.totalTokens,
    inputTokens: fromAgent.inputTokens,
    outputTokens: fromAgent.outputTokens,
    turns: fromAgent.turns,
    durationMs: fromAgent.durationMs > 0 ? fromAgent.durationMs : measuredDurationMs,
    ...(fromAgent.costUsd !== undefined ? { costUsd: fromAgent.costUsd } : {}),
  };
}

/** Brief acknowledgement window for iterator.return() after a timeout. */
const RETURN_ACK_TIMEOUT_MS = 250;

interface CollectResult {
  readonly timedOut: boolean;
  /** True when iterator.return() resolved within RETURN_ACK_TIMEOUT_MS. */
  readonly returnAwaited: boolean;
}

async function collectTranscriptWithTimeout(
  agent: AgentHandle,
  task: EvalTask,
  transcript: EngineEvent[],
  timeoutMs: number,
): Promise<CollectResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Suppress the orphan-rejection path: the consumer of `timeoutPromise`
  // is `Promise.race`; we still attach a no-op handler so a sync agent
  // failure (which exits before we ever race) cannot surface as an
  // unhandled rejection later.
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("timeout"));
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  timeoutPromise.catch(() => {
    // intentionally swallowed — the only meaningful consumer is Promise.race below
  });
  try {
    const inputWithSignal = { ...task.input, signal: controller.signal };
    const iterator = agent.stream(inputWithSignal)[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await Promise.race([iterator.next(), timeoutPromise]);
        if (next.done) return { timedOut: false, returnAwaited: true };
        transcript.push(next.value);
      }
    } catch (e: unknown) {
      if (controller.signal.aborted) {
        // Even if the iterator does not implement return(), classify this
        // as a timeout so cancellation reports as "unconfirmed" instead
        // of "n/a". A non-cancellable iterator is by definition unable to
        // confirm teardown.
        const returnAwaited = iterator.return !== undefined ? await raceReturn(iterator) : false;
        throw createTimeoutMarker(e, returnAwaited);
      }
      throw e;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface TimeoutMarker {
  readonly cause: unknown;
  readonly returnAwaited: boolean;
  readonly timedOut: true;
}

function createTimeoutMarker(cause: unknown, returnAwaited: boolean): Error {
  const err = new Error(errorMessage(cause), { cause });
  Object.assign(err, { __evalTimeout: true, returnAwaited } satisfies Partial<TimeoutMarker> & {
    __evalTimeout: true;
  });
  return err;
}

function readTimeoutMarker(e: unknown): { timedOut: true; returnAwaited: boolean } | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const marker = e as { __evalTimeout?: boolean; returnAwaited?: boolean };
  if (marker.__evalTimeout !== true) return undefined;
  return { timedOut: true, returnAwaited: marker.returnAwaited === true };
}

async function raceReturn(iterator: AsyncIterator<EngineEvent>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutFalse = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), RETURN_ACK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      iterator
        .return?.(undefined)
        .then(() => true)
        .catch(() => false) ?? Promise.resolve(false),
      timeoutFalse,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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

/** Maximum time to wait for an agent's dispose() before abandoning it. */
const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000;

/** @returns true if dispose() finished within timeoutMs (or wasn't needed). */
async function disposeSafely(agent: AgentHandle | undefined, timeoutMs: number): Promise<boolean> {
  if (agent?.dispose === undefined) return true;
  // Bound disposal so a non-cooperative agent that hangs in dispose() cannot
  // wedge the entire eval run after its trial has already timed out.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMarker: unique symbol = Symbol();
  const timeout = new Promise<typeof timeoutMarker>((resolve) => {
    timer = setTimeout(() => resolve(timeoutMarker), timeoutMs);
  });
  try {
    const winner = await Promise.race([
      Promise.resolve(agent.dispose()).then(
        () => true as const,
        () => "rejected" as const, // dispose() threw — teardown not confirmed
      ),
      timeout,
    ]);
    if (winner === timeoutMarker || winner === "rejected") return false;
    return true;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
