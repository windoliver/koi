/**
 * Skill-based agent discovery utility.
 *
 * Filters agents from the registry by skill name, using the "skills"
 * metadata field convention.
 */

import type { AgentRegistry, RegistryEntry } from "@koi/core";

/**
 * Discover agents that have a specific skill listed in their metadata.
 *
 * Searches `entry.metadata.skills` (expected to be a string array) for
 * a matching skill name.
 */
export async function discoverBySkill(
  registry: AgentRegistry,
  skill: string,
): Promise<readonly RegistryEntry[]> {
  const all = await registry.list();
  return all.filter((entry) => {
    const skills = entry.metadata.skills;
    if (!Array.isArray(skills)) return false;
    return skills.includes(skill);
  });
}
