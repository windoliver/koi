/**
 * `discoverBySkill` — convenience helper for filtering agents by their declared skills.
 *
 * The standard `RegistryFilter` only supports a single `capability` match. This helper
 * lets callers find every agent whose `metadata.skills` (string[]) contains the given skill.
 */

import type { AgentRegistry, RegistryEntry } from "@koi/core";

export async function discoverBySkill(
  registry: AgentRegistry,
  skill: string,
): Promise<readonly RegistryEntry[]> {
  const all = await registry.list();
  return all.filter((entry) => {
    const skills = entry.metadata.skills;
    return Array.isArray(skills) && skills.includes(skill);
  });
}
