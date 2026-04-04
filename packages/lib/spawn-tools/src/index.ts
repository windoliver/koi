/**
 * @koi/spawn-tools — LLM-callable agent spawn tool + coordinator utilities (L2).
 *
 * Provides:
 *   agent_spawn    — LLM tool: spawn a named child agent for a task
 *   TaskCascade    — find ready tasks, detect dependency cycles
 *   recoverOrphanedTasks — restart recovery: kill orphaned tasks + re-queue
 */

export type { OrphanRecoveryResult } from "./cascade/recover-orphans.js";
export { recoverOrphanedTasks } from "./cascade/recover-orphans.js";
export type { TaskCascade } from "./cascade/task-cascade.js";
export { createTaskCascade } from "./cascade/task-cascade.js";
export { createSpawnTools } from "./create-spawn-tools.js";
export type { SpawnToolsConfig } from "./types.js";
