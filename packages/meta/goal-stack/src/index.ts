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
  GoalReminderConfig,
  PlanConfig,
  PlanItem,
  PlanStatus,
  ReminderSessionState,
  ReminderSource,
  TodoItem,
  TodoItemStatus,
  TodoState,
} from "@koi/middleware-goal";
// ── Constants: sub-package re-exports ──────────────────────────────────
export { descriptor as planningDescriptor } from "@koi/middleware-goal";
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
