/**
 * Types for @koi/goal-stack — goal-directed middleware bundle (Layer 3).
 */

import type { ComponentProvider, KoiMiddleware } from "@koi/core";
import type { TurnContext } from "@koi/core/middleware";
import type { PlanItem, ReminderSource, TodoItem } from "@koi/middleware-goal";

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** Available composition presets for the goal stack. */
export type GoalStackPreset = "minimal" | "standard" | "autonomous";

/**
 * Preset specification — controls which sub-middleware are included
 * and their default configuration values.
 */
export interface GoalStackPresetSpec {
  readonly includeAnchor: boolean;
  readonly includeReminder: boolean;
  readonly includePlanning: boolean;
  readonly reminderBaseInterval: number;
  readonly reminderMaxInterval: number;
  readonly anchorHeader: string;
  readonly reminderHeader: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** User-facing configuration for createGoalStack(). */
export interface GoalStackConfig {
  /** Preset name. Default: "standard". */
  readonly preset?: GoalStackPreset | undefined;
  /** Declared task objectives — required when anchor or reminder is active. */
  readonly objectives?: readonly string[] | undefined;
  /** Goal-anchor overrides (injected every model call). */
  readonly anchor?:
    | {
        readonly header?: string | undefined;
        readonly onComplete?: ((item: TodoItem) => void) | undefined;
      }
    | undefined;
  /** Goal-reminder overrides (adaptive periodic injection). */
  readonly reminder?:
    | {
        readonly header?: string | undefined;
        readonly baseInterval?: number | undefined;
        readonly maxInterval?: number | undefined;
        readonly isDrifting?: ((ctx: TurnContext) => boolean | Promise<boolean>) | undefined;
        readonly sources?: readonly ReminderSource[] | undefined;
      }
    | undefined;
  /** Planning middleware overrides (write_plan tool). */
  readonly planning?:
    | {
        readonly onPlanUpdate?: ((plan: readonly PlanItem[]) => void) | undefined;
        readonly priority?: number | undefined;
      }
    | undefined;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Metadata about the resolved goal stack composition. */
export interface ResolvedGoalStackMeta {
  readonly preset: GoalStackPreset;
  readonly middlewareCount: number;
  readonly includesAnchor: boolean;
  readonly includesReminder: boolean;
  readonly includesPlanning: boolean;
}

/** The composed goal stack bundle returned by createGoalStack(). */
export interface GoalStackBundle {
  /** Ordered middleware array (by priority: reminder 330, anchor 340, planning 450). */
  readonly middlewares: readonly KoiMiddleware[];
  /** Component providers — always empty, future-proof slot. */
  readonly providers: readonly ComponentProvider[];
  /** Metadata about the resolved composition. */
  readonly config: ResolvedGoalStackMeta;
}
