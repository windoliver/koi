/**
 * Skill-stack deployment presets.
 *
 * Each preset defines a security severity threshold and watch default.
 */

import type { Severity } from "@koi/validation";
import type { SkillStackPreset } from "./types.js";

export interface SkillStackPresetSpec {
  /** Reject skills with findings at or above this severity. */
  readonly securityThreshold: Severity;
  /** Whether file watching is enabled by default. */
  readonly watchDefault: boolean;
}

export const SKILL_STACK_PRESET_SPECS: Readonly<Record<SkillStackPreset, SkillStackPresetSpec>> =
  Object.freeze({
    restrictive: Object.freeze({
      securityThreshold: "MEDIUM",
      watchDefault: false,
    }),
    standard: Object.freeze({
      securityThreshold: "HIGH",
      watchDefault: true,
    }),
    permissive: Object.freeze({
      securityThreshold: "CRITICAL",
      watchDefault: true,
    }),
  });
