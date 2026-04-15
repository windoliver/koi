/**
 * @koi/middleware-goal — Goal-tracking middleware with adaptive reminders.
 */

export type {
  DetectCompletionsFn,
  DriftJudgeInput,
  DriftUserMessage,
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
export { createGoalMiddleware } from "./goal.js";
export {
  computeNextInterval,
  detectCompletions,
  extractKeywords,
  isDrifting,
  normalizeText,
  renderGoalBlock,
} from "./goal-helpers.js";
