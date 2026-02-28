/**
 * @koi/middleware-goal-reminder — Adaptive periodic context refresh middleware (Layer 2)
 *
 * Injects goal/constraint reminders every N turns with adaptive intervals.
 * Uses drift detection to adjust injection frequency: doubles interval when
 * on-track, resets to base on drift. Inspired by Claude Code's every-5-turn
 * system reminders.
 *
 * Complementary to @koi/middleware-goal-anchor:
 * - goal-anchor injects on EVERY model call (constant reinforcement)
 * - goal-reminder injects PERIODICALLY with adaptive intervals (drift-responsive)
 *
 * Middleware name: "goal-reminder"
 * Priority: 330 (runs before goal-anchor at 340)
 *
 * Depends on @koi/core only.
 */

export type { GoalReminderConfig } from "./config.js";
export { validateGoalReminderConfig } from "./config.js";
export type { GoalExtractor, GoalExtractorConfig } from "./goal-extractor.js";
export { createGoalExtractorSource } from "./goal-extractor.js";
export { createGoalReminderMiddleware } from "./goal-reminder.js";
export { computeNextInterval, defaultIsDrifting } from "./interval.js";
export { resolveAllSources } from "./sources.js";
export type { ReminderSessionState, ReminderSource } from "./types.js";
