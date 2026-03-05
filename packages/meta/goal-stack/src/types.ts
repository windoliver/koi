/**
 * Types for the goal-stack L3 bundle.
 *
 * Reuses L2 config types directly (GoalAnchorConfig, GoalReminderConfig, PlanConfig)
 * to avoid type drift. Presets only control which middleware to enable — they don't
 * supply domain values like objectives or sources.
 */

import type { KoiMiddleware } from "@koi/core";
import type { GoalAnchorConfig } from "@koi/middleware-goal-anchor";
import type { GoalReminderConfig } from "@koi/middleware-goal-reminder";
import type { PlanConfig } from "@koi/middleware-planning";

// ---------------------------------------------------------------------------
// Resolved config
// ---------------------------------------------------------------------------

/** Resolved config returned by `resolveGoalStackConfig()`. */
export interface ResolvedGoalStackConfig {
  readonly planning: Omit<PlanConfig, "priority"> | undefined;
  readonly anchor: GoalAnchorConfig | undefined;
  readonly reminder: GoalReminderConfig | undefined;
  readonly meta: ResolvedGoalStackMeta;
}

// ---------------------------------------------------------------------------
// Preset
// ---------------------------------------------------------------------------

/** Which middleware are enabled by default. */
export type GoalStackPreset = "light" | "standard" | "full";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Top-level config for the goal stack bundle.
 *
 * - `preset` selects which middleware are enabled by default (default: "light")
 * - Providing a middleware config explicitly enables it regardless of preset
 * - Priority is blocked on planning to preserve stack ordering (330, 340, 450)
 */
export interface GoalStackConfig {
  readonly preset?: GoalStackPreset | undefined;
  readonly anchor?: GoalAnchorConfig | undefined;
  readonly reminder?: GoalReminderConfig | undefined;
  readonly planning?: Omit<PlanConfig, "priority"> | undefined;
}

// ---------------------------------------------------------------------------
// Preset flags
// ---------------------------------------------------------------------------

/** Per-preset flags controlling which middleware are enabled. */
export interface GoalStackPresetFlags {
  readonly planning: boolean;
  readonly anchor: boolean;
  readonly reminder: boolean;
}

// ---------------------------------------------------------------------------
// Resolved metadata
// ---------------------------------------------------------------------------

/** Inspection metadata returned alongside the assembled middleware array. */
export interface ResolvedGoalStackMeta {
  readonly preset: GoalStackPreset;
  readonly middlewareCount: number;
  readonly planning: boolean;
  readonly anchor: boolean;
  readonly reminder: boolean;
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

/** Return value of `createGoalStack()`. */
export interface GoalStackBundle {
  readonly middlewares: readonly KoiMiddleware[];
  readonly config: ResolvedGoalStackMeta;
}
