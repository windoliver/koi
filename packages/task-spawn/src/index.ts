/**
 * @koi/task-spawn — Lightweight task tool for zero-friction subagent spawning (Layer 2)
 *
 * Injects a `task` tool via ComponentProvider that delegates work to
 * pre-registered subagent types. The spawn callback is provided by the
 * consumer (L3/app) to keep this package free of L1 imports.
 *
 * Depends on @koi/core only.
 */

export { validateTaskSpawnConfig } from "./config.js";
export { extractOutput } from "./output.js";
export { createTaskSpawnProvider } from "./provider.js";
export { createTaskTool } from "./task-tool.js";
export type {
  AgentResolver,
  MessageFn,
  SpawnFn,
  TaskableAgent,
  TaskableAgentSummary,
  TaskMessageRequest,
  TaskSpawnConfig,
  TaskSpawnRequest,
  TaskSpawnResult,
} from "./types.js";
export {
  createMapAgentResolver,
  createTaskToolDescriptor,
  DEFAULT_MAX_DURATION_MS,
  isTaskSpawnFailure,
  isTaskSpawnSuccess,
  TASK_TOOL_DESCRIPTOR,
} from "./types.js";
