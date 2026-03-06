/**
 * @koi/middleware-goal — Goal-directed middleware trio (Layer 2)
 *
 * Merges three complementary middlewares into one package:
 * - **goal-anchor** (priority 340): injects a live todo list on every model call
 * - **goal-reminder** (priority 330): adaptive periodic goal/constraint injection
 * - **planning** (priority 450): structured write_plan tool for multi-step tasks
 */

// ── Anchor ────────────────────────────────────────────────────────────
export type { GoalAnchorConfig } from "./anchor/config.js";
export { validateGoalAnchorConfig } from "./anchor/config.js";
export { createGoalAnchorMiddleware } from "./anchor/goal-anchor.js";
export { createTodoState, detectCompletions, renderTodoBlock } from "./anchor/todo.js";
export type { TodoItem, TodoItemStatus, TodoState } from "./anchor/types.js";
// ── Planning ──────────────────────────────────────────────────────────
export { validatePlanConfig } from "./planning/config.js";
export { descriptor } from "./planning/descriptor.js";
export { createPlanMiddleware } from "./planning/plan-middleware.js";
export {
  PLAN_SYSTEM_PROMPT,
  WRITE_PLAN_DESCRIPTOR,
  WRITE_PLAN_TOOL_NAME,
} from "./planning/plan-tool.js";
export type { PlanConfig, PlanItem, PlanStatus } from "./planning/types.js";
// ── Reminder ──────────────────────────────────────────────────────────
export type { GoalReminderConfig } from "./reminder/config.js";
export { validateGoalReminderConfig } from "./reminder/config.js";
export type { GoalExtractor, GoalExtractorConfig } from "./reminder/goal-extractor.js";
export { createGoalExtractorSource } from "./reminder/goal-extractor.js";
export { createGoalReminderMiddleware } from "./reminder/goal-reminder.js";
export { computeNextInterval, defaultIsDrifting } from "./reminder/interval.js";
export { resolveAllSources } from "./reminder/sources.js";
export type { ReminderSessionState, ReminderSource } from "./reminder/types.js";
