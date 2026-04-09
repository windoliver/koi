/**
 * @koi/spawn-tools — LLM-callable agent spawn tool + coordinator utilities (L2).
 *
 * Provides:
 *   agent_spawn             — LLM tool: spawn a named child agent for a task
 *   TaskCascade             — find ready tasks, detect dependency cycles
 *   recoverOrphanedTasks    — restart recovery: unassign in_progress orphans
 *   recoverStaleDelegations — restart recovery: clear pending delegations
 *                             whose intended worker is no longer alive
 */

export type { OrphanRecoveryResult, StaleDelegationResult } from "./cascade/recover-orphans.js";
export { recoverOrphanedTasks, recoverStaleDelegations } from "./cascade/recover-orphans.js";
export type { TaskCascade } from "./cascade/task-cascade.js";
export { createTaskCascade } from "./cascade/task-cascade.js";
export { createSpawnTools } from "./create-spawn-tools.js";
export type { SpawnToolsConfig } from "./types.js";
