/**
 * Skill gating — filters skill configs by runtime requirements.
 *
 * Pure function: takes skill configs + current environment → returns eligible + skipped.
 */

import type { BrickRequires, CredentialComponent, SkillConfig, SkippedComponent } from "@koi/core";
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

/**
 * Async skill gating — runs sync `gateSkills()` first, then validates credentials
 * on eligible skills.
 *
 * Dedupes credential refs across skills before resolving.
 */
export async function gateSkillsWithCredentials(
  skills: readonly SkillConfig[],
  requiresMap?: ReadonlyMap<string, BrickRequires>,
  credentials?: CredentialComponent,
): Promise<GateResult> {
  // Phase 1: sync gating (bins, env, platform)
  const syncResult = gateSkills(skills, requiresMap);

  if (credentials === undefined || requiresMap === undefined) {
    return syncResult;
  }

  // Phase 2: async credential gating on eligible skills
  const eligible: SkillConfig[] = [];
  const skipped: SkippedComponent[] = [...syncResult.skipped];

  // Dedupe credential refs across all eligible skills
  const refSet = new Set<string>();
  for (const skill of syncResult.eligible) {
    const requires = requiresMap.get(skill.name);
    if (requires?.credentials !== undefined) {
      for (const cred of Object.values(requires.credentials)) {
        refSet.add(cred.ref);
      }
    }
  }

  // Batch-resolve unique refs once
  const resolvedRefs = new Map<string, string | undefined>();
  const resolvePromises = [...refSet].map(async (ref) => {
    const value = await credentials.get(ref);
    resolvedRefs.set(ref, value);
  });
  await Promise.all(resolvePromises);

  // Gate each eligible skill using pre-resolved values
  for (const skill of syncResult.eligible) {
    const requires = requiresMap.get(skill.name);
    if (requires?.credentials === undefined) {
      eligible.push(skill);
      continue;
    }

    const missing: string[] = [];
    for (const [name, cred] of Object.entries(requires.credentials)) {
      if (cred.ref.trim() === "" || resolvedRefs.get(cred.ref) === undefined) {
        missing.push(name);
      }
    }

    if (missing.length > 0) {
      skipped.push({ name: skill.name, reason: `Missing credentials: ${missing.join(", ")}` });
    } else {
      eligible.push(skill);
    }
  }

  return { eligible, skipped };
}
