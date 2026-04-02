/**
 * @koi/middleware-goal — Goal-tracking middleware with adaptive reminders.
 */

export type { GoalMiddlewareConfig } from "./config.js";
export {
  DEFAULT_BASE_INTERVAL,
  DEFAULT_GOAL_HEADER,
  DEFAULT_MAX_INTERVAL,
  validateGoalConfig,
} from "./config.js";
export {
  computeNextInterval,
  createGoalMiddleware,
  detectCompletions,
  extractKeywords,
  isDrifting,
  renderGoalBlock,
} from "./goal.js";
