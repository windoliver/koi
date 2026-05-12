/**
 * `discoverBySkill` — convenience helper for filtering agents by their declared skills.
 *
 * The standard `RegistryFilter` only supports a single `capability` match. This helper
 * lets callers find every agent whose `metadata.skills` (string[]) contains the given skill.
 *
 * `visibility` is mandatory: skill-based discovery must go through the same permission
 * boundary as `registry.list()`. Pass-through is the only safe behavior — defaulting
 * to "no context" would silently fail-open and let callers enumerate agents they are
 * not allowed to see.
 */

import type { AgentRegistry, RegistryEntry, VisibilityContext } from "@koi/core";

export async function discoverBySkill(
  registry: AgentRegistry,
  skill: string,
  visibility: VisibilityContext,
): Promise<readonly RegistryEntry[]> {
  const all = await registry.list(undefined, visibility);
  return all.filter((entry) => {
    const skills = entry.metadata.skills;
    return Array.isArray(skills) && skills.includes(skill);
  });
}
