/**
 * Preset specifications for goal stack composition.
 */

import type { GoalStackPreset, GoalStackPresetSpec } from "./types.js";

/**
 * Preset specifications keyed by preset name.
 *
 * - minimal: planning only — no anchor/reminder, no objectives required
 * - standard: all three middlewares, moderate reminder intervals (5/20)
 * - autonomous: all three middlewares, tighter reminder intervals (3/10)
 */
export const GOAL_STACK_PRESET_SPECS: Readonly<Record<GoalStackPreset, GoalStackPresetSpec>> =
  Object.freeze({
    minimal: Object.freeze({
      includeAnchor: false,
      includeReminder: false,
      includePlanning: true,
      reminderBaseInterval: 5,
      reminderMaxInterval: 20,
      anchorHeader: "## Current Objectives",
      reminderHeader: "Reminder",
    }),
    standard: Object.freeze({
      includeAnchor: true,
      includeReminder: true,
      includePlanning: true,
      reminderBaseInterval: 5,
      reminderMaxInterval: 20,
      anchorHeader: "## Current Objectives",
      reminderHeader: "Reminder",
    }),
    autonomous: Object.freeze({
      includeAnchor: true,
      includeReminder: true,
      includePlanning: true,
      reminderBaseInterval: 3,
      reminderMaxInterval: 10,
      anchorHeader: "## Current Objectives",
      reminderHeader: "Reminder",
    }),
  });
