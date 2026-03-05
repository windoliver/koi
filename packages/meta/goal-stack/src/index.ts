/**
 * @koi/goal-stack — Goal-directed middleware bundle (Layer 3)
 *
 * One-call composition of goal-anchor, goal-reminder, and planning middleware
 * with preset-driven defaults.
 *
 * Usage:
 * ```typescript
 * import { createGoalStack } from "@koi/goal-stack";
 *
 * const { middlewares, providers, config } = createGoalStack({
 *   preset: "standard",
 *   objectives: ["Implement auth flow", "Write unit tests"],
 * });
 * ```
 */

// ── Types: sub-package re-exports ──────────────────────────────────────
export type {
  GoalAnchorConfig,
  TodoItem,
  TodoItemStatus,
  TodoState,
} from "@koi/middleware-goal-anchor";
export type {
  GoalReminderConfig,
  ReminderSessionState,
  ReminderSource,
} from "@koi/middleware-goal-reminder";
export type { PlanConfig, PlanItem, PlanStatus } from "@koi/middleware-planning";
// ── Constants: sub-package re-exports ──────────────────────────────────
export { descriptor as planningDescriptor } from "@koi/middleware-planning";
// ── Functions ──────────────────────────────────────────────────────────
export { resolveGoalStackConfig } from "./config-resolution.js";
export { createGoalStack } from "./goal-stack.js";
// ── Constants ──────────────────────────────────────────────────────────
export { GOAL_STACK_PRESET_SPECS } from "./presets.js";
// ── Types: goal-stack bundle ───────────────────────────────────────────
export type {
  GoalStackBundle,
  GoalStackConfig,
  GoalStackPreset,
  GoalStackPresetSpec,
  ResolvedGoalStackMeta,
} from "./types.js";
