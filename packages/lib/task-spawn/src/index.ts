/**
 * @koi/task-spawn — Lightweight task tool for zero-friction subagent spawning.
 *
 * Spec: docs/L2/task-spawn.md
 *
 * Injects a `task` tool that lets a parent agent delegate work to subagent
 * types. The spawn callback is provided by the consumer (L3/app), keeping
 * this package free of L1 engine imports.
 */

export type {
  AutonomousReconcileAction,
  AutonomousReconcileOptions,
  AutonomousReconcileResult,
} from "./autonomous-reconciler.js";
export { reconcileTaskBoard } from "./autonomous-reconciler.js";
export { validateTaskSpawnConfig } from "./config.js";
export { extractOutput } from "./output.js";
export { createTaskSpawnProvider } from "./provider.js";
export { createRegistryAgentResolver } from "./registry-agent-resolver.js";
export type {
  SpawnFitnessOutcome,
  SpawnFitnessWrapperConfig,
} from "./spawn-fitness-wrapper.js";
export { createSpawnFitnessWrapper } from "./spawn-fitness-wrapper.js";
export { createTaskTool } from "./task-tool.js";
export type {
  AgentResolver,
  LiveAgentHandle,
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
  DEFAULT_DESCRIPTOR_TTL_MS,
  DEFAULT_MAX_DURATION_MS,
  isTaskSpawnFailure,
  isTaskSpawnSuccess,
  TASK_TOOL_DESCRIPTOR,
} from "./types.js";
