/**
 * Config resolution for goal stack — applies preset defaults and validates.
 */

import { lookupPreset } from "@koi/preset-resolver";
import { GOAL_STACK_PRESET_SPECS } from "./presets.js";
import type { GoalStackConfig, GoalStackPreset } from "./types.js";

/** Resolved internal config with preset applied. */
export interface ResolvedGoalStackConfig {
  readonly preset: GoalStackPreset;
  readonly config: GoalStackConfig;
}

/**
 * Resolves user config against the selected preset.
 *
 * Validates that objectives are provided when the preset includes
 * anchor or reminder middleware. Throws with a helpful message
 * suggesting the "minimal" preset when objectives are missing.
 */
export function resolveGoalStackConfig(config: GoalStackConfig): ResolvedGoalStackConfig {
  const { preset, spec } = lookupPreset(GOAL_STACK_PRESET_SPECS, config.preset, "standard");

  const needsObjectives = spec.includeAnchor || spec.includeReminder;
  const hasObjectives = config.objectives !== undefined && config.objectives.length > 0;
  // Custom reminder sources substitute for objectives — task-board sources provide reminder content
  const hasCustomSources =
    config.reminder?.sources !== undefined && config.reminder.sources.length > 0;

  if (needsObjectives && !hasObjectives && !hasCustomSources) {
    throw new Error(
      `GoalStackConfig: preset "${preset}" requires non-empty objectives for anchor/reminder middleware. ` +
        `Provide objectives, custom reminder sources, or use the "minimal" preset (planning only).`,
    );
  }

  return { preset, config };
}
