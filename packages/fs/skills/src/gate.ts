/**
 * Skill gating — filters skill configs by runtime requirements.
 *
 * Pure function: takes skill configs + current environment → returns eligible + skipped.
 */

import type { BrickRequires, SkillConfig, SkippedComponent } from "@koi/core";
import { validateBrickRequires } from "@koi/validation";

export interface GateResult {
  readonly eligible: readonly SkillConfig[];
  readonly skipped: readonly SkippedComponent[];
}

/**
 * Filters skills by their `requires` field (bins, env, platform).
 *
 * Skills without `requires` always pass. Skills with unsatisfied requirements
 * are moved to `skipped` with a human-readable reason.
 */
export function gateSkills(
  skills: readonly SkillConfig[],
  requiresMap?: ReadonlyMap<string, BrickRequires>,
): GateResult {
  const eligible: SkillConfig[] = [];
  const skipped: SkippedComponent[] = [];

  for (const skill of skills) {
    const requires = requiresMap?.get(skill.name);
    const result = validateBrickRequires(requires);

    if (result.ok) {
      eligible.push(skill);
    } else {
      skipped.push({ name: skill.name, reason: result.error.message });
    }
  }

  return { eligible, skipped };
}
