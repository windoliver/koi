/**
 * @koi/parallel-minions — Parallel task delegation for fan-out/fan-in patterns (Layer 2)
 *
 * Injects a `parallel_task` tool via ComponentProvider that delegates
 * multiple tasks to pre-registered subagent types running concurrently.
 * Supports best-effort, fail-fast, and quorum execution strategies.
 *
 * Depends on @koi/core only.
 */

export { validateParallelMinionsConfig } from "./config.js";
export { executeBatch } from "./executor.js";
export { createLaneSemaphore } from "./lane-semaphore.js";
export { formatBatchResult } from "./output.js";
export { createParallelTool } from "./parallel-tool.js";
export { createParallelMinionsProvider } from "./provider.js";
export { createSemaphore } from "./semaphore.js";
export {
  PARALLEL_MINIONS_SKILL,
  PARALLEL_MINIONS_SKILL_CONTENT,
  PARALLEL_MINIONS_SKILL_NAME,
} from "./skill.js";
export { mapSpawnToMinion } from "./spawn-adapter.js";
export {
  createBestEffortStrategy,
  createFailFastStrategy,
  createQuorumStrategy,
} from "./strategies.js";
export type {
  BatchResult,
  BatchSummary,
  ConcurrencyGate,
  ExecutionContext,
  ExecutionStrategy,
  ExecutionStrategyKind,
  LaneConcurrency,
  MinionableAgent,
  MinionOutcome,
  MinionSpawnFn,
  MinionSpawnRequest,
  MinionSpawnResult,
  MinionTask,
  ParallelMinionsConfig,
  ResolvedTask,
  Semaphore,
} from "./types.js";
export {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_MAX_OUTPUT_PER_TASK,
  DEFAULT_MAX_TOTAL_OUTPUT,
  DEFAULT_STRATEGY,
  isMinionOutcomeFailure,
  isMinionOutcomeSuccess,
  isMinionSpawnFailure,
  isMinionSpawnSuccess,
  MAX_TASKS_PER_BATCH,
  PARALLEL_TOOL_DESCRIPTOR,
} from "./types.js";
