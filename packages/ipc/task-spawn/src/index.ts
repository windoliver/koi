/**
 * @koi/task-spawn — Lightweight task tool for zero-friction subagent spawning (Layer 2)
 *
 * Injects a `task` tool via ComponentProvider that delegates work to
 * pre-registered subagent types. The spawn callback is provided by the
 * consumer (L3/app) to keep this package free of L1 imports.
 *
 * Depends on @koi/core only.
 */

// Re-export L0 types (backward compat — consumers can also import from @koi/core directly)
export type {
  AgentResolver,
  LiveAgentHandle,
  TaskableAgent,
  TaskableAgentSummary,
} from "@koi/core/agent-resolver";
export { validateTaskSpawnConfig } from "./config.js";
export { createMailboxMessageFn, type MailboxMessageFnConfig } from "./mailbox-message-fn.js";
export { extractOutput } from "./output.js";
export { createTaskSpawnProvider } from "./provider.js";
export { createRegistryAgentResolver } from "./registry-agent-resolver.js";
export { TASK_SPAWN_SKILL, TASK_SPAWN_SKILL_CONTENT, TASK_SPAWN_SKILL_NAME } from "./skill.js";
export { mapSpawnToTask } from "./spawn-adapter.js";
export { createTaskTool, DEFAULT_DESCRIPTOR_TTL_MS } from "./task-tool.js";
export type {
  MessageFn,
  SpawnFn,
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
