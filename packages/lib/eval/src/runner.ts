import { createHash } from "node:crypto";
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
      // Isolate reporter failures from core execution: a logging hook
      // throwing must not erase the eval results we already collected.
      try {
        config.onTrialComplete?.(trial);
      } catch {
        // swallow — hook failures are not the eval's job to surface
      }
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
    // Fail fast on non-fingerprintable tasks before any trial executes.
    // computeTaskFingerprint throws if input contains functions/symbols
    // and no fingerprintSalt is set; surfacing that here prevents wasted
    // agent execution and partial side effects.
    computeTaskFingerprint(task);
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
    // Require a terminal `done` event with a "completed" stop reason. An
    // adapter that exits early (iterator exhausted without emitting done)
    // produces a partial transcript that graders' text_delta fallback
    // could mis-grade as a pass. Surface as an error instead.
    const terminal = findTerminalDone(transcript);
    if (terminal === undefined) {
      throw new Error("agent stream ended without a terminal 'done' event");
    }
    if (terminal.output.stopReason !== "completed") {
      throw new Error(
        `agent stream stopped with non-completed reason: ${terminal.output.stopReason}`,
      );
    }
  } catch (e: unknown) {
    const marker = readTimeoutMarker(e);
    if (marker !== undefined) {
      timedOut = true;
      returnAwaited = marker.returnAwaited;
    }
    trialError = e;
  }
  const disposeAwaited = await disposeSafely(agent, disposeTimeoutMs);
  // Teardown semantics:
  // - Timeout path: confirmed only when both iterator.return() and
  //   dispose() acknowledged.
  // - Non-timeout path: a failed/hung dispose() is still a leaked agent —
  //   surface it as `unconfirmed` so the outer loop aborts subsequent
  //   trials instead of pretending isolation held.
  const cancellation: CancellationStatus = timedOut
    ? returnAwaited && disposeAwaited
      ? "confirmed"
      : "unconfirmed"
    : disposeAwaited
      ? "n/a"
      : "unconfirmed";

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
  const done = findTerminalDone(transcript);
  return done?.output.metrics;
}

function findTerminalDone(
  transcript: readonly EngineEvent[],
): Extract<EngineEvent, { kind: "done" }> | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const ev = transcript[i];
    if (ev?.kind === "done") return ev;
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
    // Wrap the dispose() invocation itself in a thunk so a synchronous
    // throw from agent.dispose() (its type allows void or Promise<void>)
    // is captured here and downgraded to "rejected" instead of escaping
    // out of disposeSafely() and tearing down the whole eval run.
    const disposePromise = Promise.resolve()
      .then(() => agent.dispose?.())
      .then(
        () => true as const,
        () => "rejected" as const,
      );
    const winner = await Promise.race([disposePromise, timeout]);
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
    taskFingerprint: computeTaskFingerprint(task),
  };
}

/**
 * Stable fingerprint of a task definition: SHA-256 over a canonical JSON
 * encoding of its observable inputs. compareRuns() rejects per-task
 * comparisons where the baseline and current fingerprints disagree.
 *
 * We deliberately fingerprint only what determines what's being measured:
 * input messages, expectation, and the set of grader IDs (in stable order).
 * Grader options live behind the EvalGrader interface and are not
 * introspectable here without breaking the L0/L2 boundary.
 */
export function computeTaskFingerprint(task: EvalTask): string {
  // Reject silently-equivalent fingerprints: EngineInput may carry
  // function values (callHandlers etc) whose identity matters for behavior
  // but whose serialization collapses to "fn:<name>". Refuse to fingerprint
  // such inputs unless the caller provides an explicit
  // `fingerprintSalt` to capture the runtime semantics. Without this the
  // gate could compare materially different agents as equivalent.
  if (containsNonSerializable(task.input) && task.fingerprintSalt === undefined) {
    throw new Error(
      `EvalTask "${task.id}": input contains non-serializable values (functions, etc.); set fingerprintSalt to capture runtime semantics`,
    );
  }
  const canonical = canonicalize({
    input: task.input,
    expected: task.expected,
    graders: task.graders.map((g) => ({ id: g.id, config: g.configFingerprint ?? "" })),
    // Execution-semantic fields: changing trial count or per-task timeout
    // changes what the suite actually measures (flakiness exposure, slow
    // failure modes), so reused taskIds with different values must not
    // compare as equivalent.
    trialCount: task.trialCount,
    timeoutMs: task.timeoutMs,
    salt: task.fingerprintSalt,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function containsNonSerializable(v: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (v === null) return false;
  const t = typeof v;
  if (t === "function" || t === "symbol") return true;
  if (t !== "object") return false;
  if (Array.isArray(v)) return v.some((e) => containsNonSerializable(e, depth + 1));
  for (const k of Object.keys(v as object)) {
    if (containsNonSerializable((v as Record<string, unknown>)[k], depth + 1)) return true;
  }
  return false;
}

/**
 * Stable JSON-like serialization. Goals:
 * - Sort object keys recursively so equal values produce equal output.
 * - Preserve RegExp source + flags (default JSON.stringify drops them).
 * - Preserve undefined as a distinct value from missing key.
 *
 * Anything still unrepresentable falls through to `String(v)` rather than
 * silently collapsing to `{}` — that way swapping in a new value cannot
 * leave the fingerprint unchanged.
 */
function canonicalize(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (v instanceof RegExp) return `RegExp(${JSON.stringify(v.source)},${JSON.stringify(v.flags)})`;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return JSON.stringify(v);
  if (t === "bigint") return `bigint:${(v as bigint).toString()}`;
  if (t === "function") return `fn:${(v as () => unknown).name || "anon"}`;
  if (t === "symbol") return `sym:${(v as symbol).toString()}`;
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (t === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  return String(v);
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
