/**
 * Eval runner — orchestrates task execution, grading, and summary computation.
 */

import type { EngineEvent, EngineMetrics } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_TIMEOUT_MS,
  validateEvalConfig,
} from "./config.js";
import { runPool } from "./pool.js";
import { computeSummary } from "./scorer.js";
import { collectTranscript, extractMetrics } from "./transcript.js";
import type {
  AgentHandle,
  EvalRun,
  EvalRunConfig,
  EvalRunner,
  EvalScore,
  EvalTask,
  EvalTrial,
} from "./types.js";

/**
 * Creates an eval runner from a validated config.
 */
export function createEvalRunner(config: EvalRunConfig): EvalRunner {
  const validated = validateEvalConfig(config);
  if (!validated.ok) {
    throw KoiRuntimeError.from("VALIDATION", validated.error.message);
  }

  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  const globalTimeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const passThreshold = config.passThreshold ?? DEFAULT_PASS_THRESHOLD;

  return {
    async run(): Promise<EvalRun> {
      const runId = generateRunId();
      const timestamp = new Date().toISOString();

      const trialDescriptors = config.tasks.flatMap((task) => {
        const count = task.trialCount ?? 1;
        return Array.from({ length: count }, (_, i) => ({ task, trialIndex: i }));
      });

      const trialTasks = trialDescriptors.map(
        ({ task, trialIndex }) =>
          () =>
            executeTrial(task, trialIndex, globalTimeout, passThreshold, config),
      );

      const trials = await runPool(trialTasks, concurrency, config.onTrialComplete);
      const summary = computeSummary(trials, [...config.tasks]);

      return {
        id: runId,
        name: config.name,
        timestamp,
        config: {
          name: config.name,
          concurrency,
          timeoutMs: globalTimeout,
          passThreshold,
          taskCount: config.tasks.length,
        },
        trials,
        summary,
      };
    },
  };
}

async function executeTrial(
  task: EvalTask,
  trialIndex: number,
  globalTimeout: number,
  passThreshold: number,
  config: EvalRunConfig,
): Promise<EvalTrial> {
  const timeoutMs = task.timeoutMs ?? globalTimeout;
  const start = Date.now();
  // let justified: agent reference needed in finally for disposal
  let agent: AgentHandle | undefined;

  try {
    agent = await config.agentFactory();
    const transcript = await collectWithTimeout(agent, task, timeoutMs);
    const metrics = extractMetrics(transcript, Date.now() - start);
    const scores = await gradeAll(task, transcript, metrics, passThreshold);

    return {
      taskId: task.id,
      trialIndex,
      transcript,
      scores,
      metrics,
      status: scores.every((s) => s.pass) ? "pass" : "fail",
    };
  } catch (e: unknown) {
    return makeErrorTrial(task.id, trialIndex, Date.now() - start, e, timeoutMs);
  } finally {
    await disposeAgent(agent);
  }
}

async function collectWithTimeout(
  agent: AgentHandle,
  task: EvalTask,
  timeoutMs: number,
): Promise<readonly EngineEvent[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  const timeoutRejection = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return Promise.race([collectTranscript(agent.stream(task.input)), timeoutRejection]);
}

function makeErrorTrial(
  taskId: string,
  trialIndex: number,
  durationMs: number,
  e: unknown,
  timeoutMs: number,
): EvalTrial {
  const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
  const message = isTimeout
    ? `Trial timed out after ${String(timeoutMs)}ms`
    : e instanceof Error
      ? e.message
      : String(e);

  return {
    taskId,
    trialIndex,
    transcript: [],
    scores: [],
    metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs },
    status: "error",
    error: message,
  };
}

async function disposeAgent(agent: AgentHandle | undefined): Promise<void> {
  if (agent?.dispose !== undefined) {
    try {
      await agent.dispose();
    } catch {
      // Dispose errors are not propagated — agent cleanup is best-effort
    }
  }
}

async function gradeAll(
  task: EvalTask,
  transcript: readonly EngineEvent[],
  metrics: EngineMetrics,
  passThreshold: number,
): Promise<readonly EvalScore[]> {
  return Promise.all(
    task.graders.map(async (grader) => {
      try {
        const score = await grader.grade(transcript, task.expected, metrics);
        return { ...score, pass: score.score >= passThreshold };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Unknown grader error";
        return {
          graderId: grader.id,
          score: 0,
          pass: false,
          reasoning: `Grader error: ${message}`,
        };
      }
    }),
  );
}

function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `eval-${timestamp}-${random}`;
}
