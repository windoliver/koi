/**
 * Frozen preset flags for the goal stack.
 *
 * Presets only control which middleware are enabled — they cannot supply
 * domain-specific config values like objectives or sources. Providing
 * explicit middleware config always wins (e.g., anchor config with "light"
 * preset still enables anchor).
 */

import type { GoalStackPreset, GoalStackPresetFlags } from "./types.js";

/** Frozen preset flag registry. */
export const GOAL_STACK_PRESET_FLAGS: Readonly<Record<GoalStackPreset, GoalStackPresetFlags>> =
  Object.freeze({
    light: Object.freeze({ planning: true, anchor: false, reminder: false }),
    standard: Object.freeze({ planning: true, anchor: true, reminder: false }),
    full: Object.freeze({ planning: true, anchor: true, reminder: true }),
  });
