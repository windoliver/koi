/**
 * @koi/middleware-task-anchor — re-anchors the model on the live task board
 * after K idle turns with no task-tool activity.
 */

export type { TaskAnchorConfig, TaskBoardAccessor, TaskToolPredicate } from "./config.js";
export {
  DEFAULT_HEADER,
  DEFAULT_IDLE_TURN_THRESHOLD,
  defaultIsTaskTool,
  validateTaskAnchorConfig,
} from "./config.js";
export { buildEmptyBoardNudge, buildTaskReminder, formatTaskList } from "./reminder-format.js";
export { createTaskAnchorMiddleware } from "./task-anchor.js";
