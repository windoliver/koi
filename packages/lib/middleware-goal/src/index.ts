/**
 * @koi/middleware-goal — Goal-tracking middleware with adaptive reminders.
 */

export type {
  DetectCompletionsFn,
  DriftJudgeInput,
  GoalItem,
  GoalItemWithId,
  GoalMiddlewareConfig,
  IsDriftingFn,
  OnCallbackErrorFn,
} from "./config.js";
export {
  DEFAULT_BASE_INTERVAL,
  DEFAULT_CALLBACK_TIMEOUT_MS,
  DEFAULT_GOAL_HEADER,
  DEFAULT_MAX_INTERVAL,
  MAX_CALLBACK_TIMEOUT_MS,
  validateGoalConfig,
} from "./config.js";
export {
  computeNextInterval,
  createGoalMiddleware,
  detectCompletions,
  extractKeywords,
  isDrifting,
  normalizeText,
  renderGoalBlock,
} from "./goal.js";
