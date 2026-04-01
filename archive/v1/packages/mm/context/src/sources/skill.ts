/**
 * Skill source resolver — looks up a skill by name from the agent's components.
 *
 * Queries SkillComponent (not SkillMetadata) so the skill's behavioral
 * instructions (content field) reach the system prompt — progressive
 * loading level 2 (body).
 */

import type { Agent, SkillComponent } from "@koi/core";
import type { SkillSource, SourceResult } from "../types.js";

/** Resolves a skill source by querying the agent's skill components. */
export function resolveSkillSource(source: SkillSource, agent: Agent): Promise<SourceResult> {
  const skills = agent.query<SkillComponent>("skill:");
  let found: SkillComponent | undefined;

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
  if (found.content.length > 0) {
    parts.push(found.content);
  }
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
