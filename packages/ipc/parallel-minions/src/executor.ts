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
 *
 * Resolution order:
 * 1. Try agentResolver.resolve() (if configured)
 * 2. Fall back to static agents map (if configured)
 * 3. Return error with available types
 */
async function resolveTask(
  task: MinionTask,
  index: number,
  config: ParallelMinionsConfig,
): Promise<ResolvedTask | string> {
  const agentType =
    typeof task.agent_type === "string" && task.agent_type.length > 0
      ? task.agent_type
      : config.defaultAgent;

  if (agentType === undefined) {
    return `Task ${index}: 'agent_type' is required when no default agent is configured`;
  }

  // Try agentResolver first
  if (config.agentResolver !== undefined) {
    const result = await Promise.resolve(config.agentResolver.resolve(agentType));
    if (result.ok) {
      return {
        index,
        description: task.description,
        agentName: result.value.name,
        agentType,
        manifest: result.value.manifest,
      };
    }
    // Resolver returned NOT_FOUND — fall through to static map
  }

  // Fall back to static agents map
  if (config.agents !== undefined) {
    const agent = config.agents.get(agentType);
    if (agent !== undefined) {
      return {
        index,
        description: task.description,
        agentName: agent.name,
        agentType,
        manifest: agent.manifest,
      };
    }
  }

  // Both resolver and static map failed — build available types list
  const available = await computeAvailableTypes(config);
  return `Task ${index}: unknown agent type '${agentType}'. Available: ${available}`;
}

/** Collects available agent type keys from resolver list() or static agents map. */
async function computeAvailableTypes(config: ParallelMinionsConfig): Promise<string> {
  if (config.agentResolver !== undefined) {
    const summaries = await Promise.resolve(config.agentResolver.list());
    const resolverKeys = summaries.map((s) => s.key);
    // Merge with static map keys if both are present
    if (config.agents !== undefined) {
      const allKeys = new Set([...resolverKeys, ...config.agents.keys()]);
      return [...allKeys].join(", ");
    }
    return resolverKeys.join(", ");
  }
  if (config.agents !== undefined) {
    return [...config.agents.keys()].join(", ");
  }
  return "(none)";
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
 * 1. Resolves agent types for each task (async, supports agentResolver + static map fallback)
 * 2. Creates batch-level AbortController with timeout
 * 3. Creates semaphore for concurrency control
 * 4. Selects and invokes the configured strategy
 * 5. Returns BatchResult
 */
export async function executeBatch(
  config: ParallelMinionsConfig,
  tasks: readonly MinionTask[],
): Promise<BatchResult> {
  const strategyKind = config.strategy ?? DEFAULT_STRATEGY;

  if (tasks.length === 0) {
    return {
      outcomes: [],
      summary: { total: 0, succeeded: 0, failed: 0, strategy: strategyKind },
    };
  }

  // Resolve all tasks in parallel — fail early on invalid agent references
  const resolutions = await Promise.all(tasks.map((task, i) => resolveTask(task, i, config)));

  const resolved: ResolvedTask[] = [];
  const errorsByIndex = new Map<number, string>();

  for (const [i, result] of resolutions.entries()) {
    if (typeof result === "string") {
      errorsByIndex.set(i, result);
    } else {
      resolved.push(result);
    }
  }

  if (errorsByIndex.size > 0) {
    return {
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
    };
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
