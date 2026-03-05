/**
 * Config resolution for the goal stack bundle.
 *
 * Determines which middleware are enabled based on preset flags and explicit config.
 * Validates that enabled middleware have required config values.
 */

import { GOAL_STACK_PRESET_FLAGS } from "./presets.js";
import type { GoalStackConfig, GoalStackPreset, ResolvedGoalStackConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve goal stack config by merging preset flags with explicit config.
 *
 * Rules:
 * - Middleware is enabled if its preset flag is true OR user provides its config
 * - If enabled by preset but no config provided, throws with a clear message
 *   (exception: planning, whose config is fully optional)
 */
export function resolveGoalStackConfig(config: GoalStackConfig = {}): ResolvedGoalStackConfig {
  const preset: GoalStackPreset = config.preset ?? "light";
  const flags = GOAL_STACK_PRESET_FLAGS[preset];

  const planningEnabled = flags.planning || config.planning !== undefined;
  const anchorEnabled = flags.anchor || config.anchor !== undefined;
  const reminderEnabled = flags.reminder || config.reminder !== undefined;

  // Validate: collect all missing-config errors in one pass
  const errors: readonly string[] = [
    ...(anchorEnabled && config.anchor === undefined
      ? [
          `Anchor middleware is enabled by preset "${preset}" but no anchor config was provided. ` +
            "Supply { anchor: { objectives: [...] } }.",
        ]
      : []),
    ...(reminderEnabled && config.reminder === undefined
      ? [
          `Reminder middleware is enabled by preset "${preset}" but no reminder config was provided. ` +
            "Supply { reminder: { sources: [...], baseInterval: N, maxInterval: N } }.",
        ]
      : []),
  ];

  if (errors.length > 0) {
    throw new Error(`[@koi/goal-stack] ${errors.join(" ")}`);
  }

  return {
    planning: planningEnabled ? (config.planning ?? {}) : undefined,
    anchor: anchorEnabled ? config.anchor : undefined,
    reminder: reminderEnabled ? config.reminder : undefined,
    meta: {
      preset,
      middlewareCount: [planningEnabled, anchorEnabled, reminderEnabled].filter(Boolean).length,
      planning: planningEnabled,
      anchor: anchorEnabled,
      reminder: reminderEnabled,
    },
  };
}
