/**
 * @koi/goal-stack — L3 meta-package for goal management middleware.
 *
 * Re-exports only. No new logic.
 */

// ---------------------------------------------------------------------------
// Type re-exports from L2 dependencies
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export { resolveGoalStackConfig } from "./config-resolution.js";
export { createGoalStack } from "./goal-stack.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export { GOAL_STACK_PRESET_FLAGS } from "./presets.js";

// ---------------------------------------------------------------------------
// Bundle types
// ---------------------------------------------------------------------------

export type {
  GoalStackBundle,
  GoalStackConfig,
  GoalStackPreset,
  GoalStackPresetFlags,
  ResolvedGoalStackConfig,
  ResolvedGoalStackMeta,
} from "./types.js";
