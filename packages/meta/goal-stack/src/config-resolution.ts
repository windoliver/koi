/**
 * Config resolution for goal stack — applies preset defaults and validates.
 */

import { GOAL_STACK_PRESET_SPECS } from "./presets.js";
import type { GoalStackConfig, GoalStackPreset } from "./types.js";

/** Default preset when none specified. */
const DEFAULT_PRESET: GoalStackPreset = "standard";

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
  const preset = config.preset ?? DEFAULT_PRESET;
  const spec = GOAL_STACK_PRESET_SPECS[preset];

  const needsObjectives = spec.includeAnchor || spec.includeReminder;
  const hasObjectives = config.objectives !== undefined && config.objectives.length > 0;

  if (needsObjectives && !hasObjectives) {
    throw new Error(
      `GoalStackConfig: preset "${preset}" requires non-empty objectives for anchor/reminder middleware. ` +
        `Provide objectives or use the "minimal" preset (planning only).`,
    );
  }

  return { preset, config };
}
