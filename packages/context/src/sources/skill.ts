/**
 * Skill source resolver — looks up a skill by name from the agent's components.
 */

import type { Agent, SkillMetadata } from "@koi/core";
import type { SkillSource, SourceResult } from "../types.js";

/** Resolves a skill source by querying the agent's skill components. */
export function resolveSkillSource(source: SkillSource, agent: Agent): Promise<SourceResult> {
  const skills = agent.query<SkillMetadata>("skill:");
  let found: SkillMetadata | undefined;

  for (const [, skill] of skills) {
    if (skill.name === source.name) {
      found = skill;
      break;
    }
  }

  if (found === undefined) {
    return Promise.reject(new Error(`Skill not found: ${source.name}`));
  }

  const parts = [`Skill: ${found.name}`, found.description];
  if (found.tags !== undefined && found.tags.length > 0) {
    parts.push(`Tags: ${found.tags.join(", ")}`);
  }
  const content = parts.join("\n");

  return Promise.resolve({
    label: source.label ?? `Skill: ${source.name}`,
    content,
    tokens: 0,
    source,
  });
}
