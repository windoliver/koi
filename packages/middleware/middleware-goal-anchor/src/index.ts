/**
 * @koi/middleware-goal-anchor — Todo-anchored attention management middleware (Layer 2)
 *
 * Injects a live todo list tracking objective completion status as a system
 * message at the start of every model call, keeping declared objectives in the
 * model's recent attention span (Manus-style attention management).
 *
 * Complementary to @koi/agent-monitor goal_drift detection:
 * - agent-monitor detects goal drift (observer)
 * - middleware-goal-anchor prevents goal drift (corrective)
 *
 * Middleware name: "goal-anchor"
 * Priority: 340 (runs just after agent-monitor at 350)
 *
 * Depends on @koi/core only.
 */

export type { GoalAnchorConfig } from "./config.js";
export { validateGoalAnchorConfig } from "./config.js";
export { createGoalAnchorMiddleware } from "./goal-anchor.js";
export { createTodoState, detectCompletions, renderTodoBlock } from "./todo.js";
export type { TodoItem, TodoItemStatus, TodoState } from "./types.js";
