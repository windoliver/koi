/**
 * @koi/task-tools — LLM-callable task management tools (L2).
 *
 * Provides 7 tools for managing a TaskBoard from within an agent session:
 * task_create, task_get, task_update, task_list, task_stop, task_output, task_delegate.
 */

export { createTaskTools } from "./create-task-tools.js";
export { createTaskToolsProvider, type TaskToolsProviderConfig } from "./provider.js";
export type {
  OutputChunkData,
  ResultSchema,
  TaskOutputReader,
  TaskOutputResponse,
  TaskSummary,
  TaskToolsConfig,
} from "./types.js";
