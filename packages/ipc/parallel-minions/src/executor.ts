/**
 * Batch executor — core orchestration for parallel task execution.
 *
 * Resolves agent types, creates abort controllers, selects strategy,
 * and returns aggregated results.
 */

import { createLaneSemaphore } from "./lane-semaphore.js";
import {
  createBestEffortStrategy,
  createFailFastStrategy,
  createQuorumStrategy,
} from "./strategies.js";
import type {
  BatchResult,
  ExecutionContext,
  MinionTask,
  ParallelMinionsConfig,
  ResolvedTask,
} from "./types.js";
import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_MAX_OUTPUT_PER_TASK,
  DEFAULT_STRATEGY,
} from "./types.js";

/**
 * Resolves the agent for a single task, returning a ResolvedTask or an error string.
 */
function resolveTask(
  task: MinionTask,
  index: number,
  config: ParallelMinionsConfig,
): ResolvedTask | string {
  const agentType =
    typeof task.agent_type === "string" && task.agent_type.length > 0
      ? task.agent_type
      : config.defaultAgent;

  if (agentType === undefined) {
    return `Task ${index}: 'agent_type' is required when no default agent is configured`;
  }

  const agent = config.agents.get(agentType);
  if (agent === undefined) {
    const available = [...config.agents.keys()].join(", ");
    return `Task ${index}: unknown agent type '${agentType}'. Available: ${available}`;
  }

  return {
    index,
    description: task.description,
    agentName: agent.name,
    agentType,
    manifest: agent.manifest,
  };
}

/**
 * Selects the execution strategy based on config.
 */
function selectStrategy(config: ParallelMinionsConfig) {
  const strategyKind = config.strategy ?? DEFAULT_STRATEGY;
  switch (strategyKind) {
    case "best-effort":
      return createBestEffortStrategy();
    case "fail-fast":
      return createFailFastStrategy();
    case "quorum":
      return createQuorumStrategy(config.quorumThreshold ?? 1);
    default: {
      const _exhaustive: never = strategyKind;
      throw new Error(`Unknown strategy: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Executes a batch of tasks in parallel with concurrency control.
 *
 * 1. Resolves agent types for each task
 * 2. Creates batch-level AbortController with timeout
 * 3. Creates semaphore for concurrency control
 * 4. Selects and invokes the configured strategy
 * 5. Returns BatchResult
 */
export function executeBatch(
  config: ParallelMinionsConfig,
  tasks: readonly MinionTask[],
): Promise<BatchResult> {
  const strategyKind = config.strategy ?? DEFAULT_STRATEGY;

  if (tasks.length === 0) {
    return Promise.resolve({
      outcomes: [],
      summary: { total: 0, succeeded: 0, failed: 0, strategy: strategyKind },
    });
  }

  // Resolve all tasks upfront — fail early on invalid agent references
  const resolved: ResolvedTask[] = [];
  const errorsByIndex = new Map<number, string>();

  for (const [i, task] of tasks.entries()) {
    const result = resolveTask(task, i, config);
    if (typeof result === "string") {
      errorsByIndex.set(i, result);
    } else {
      resolved.push(result);
    }
  }

  if (errorsByIndex.size > 0) {
    return Promise.resolve({
      outcomes: tasks.map((_, i) => ({
        ok: false as const,
        taskIndex: i,
        error: errorsByIndex.get(i) ?? "Batch had resolution errors",
      })),
      summary: {
        total: tasks.length,
        succeeded: 0,
        failed: tasks.length,
        strategy: strategyKind,
      },
    });
  }

  const maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const maxDurationMs = config.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const maxOutputPerTask = config.maxOutputPerTask ?? DEFAULT_MAX_OUTPUT_PER_TASK;

  const batchController = new AbortController();
  const timer = setTimeout(() => {
    batchController.abort("batch timeout");
  }, maxDurationMs);

  const semaphore = createLaneSemaphore(maxConcurrency, config.laneConcurrency);
  const strategy = selectStrategy(config);

  const ctx: ExecutionContext = {
    tasks: resolved,
    semaphore,
    spawn: config.spawn,
    batchSignal: batchController.signal,
    maxOutputPerTask,
    strategy: strategyKind,
  };

  return strategy(ctx).finally(() => {
    clearTimeout(timer);
  });
}
