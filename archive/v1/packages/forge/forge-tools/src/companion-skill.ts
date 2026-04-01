/**
 * Companion skill — teaches the LLM when/how to use forge self-improvement tools.
 */

import type { Agent, AttachResult, CompanionSkillDefinition, ComponentProvider } from "@koi/core";
import { skillToken } from "@koi/core";

/** Well-known skill token for forge self-improvement. */
const FORGE_SKILL_TOKEN = skillToken("forge-self-improvement");

/** Static skill definition describing forge self-improvement capabilities. */
export const FORGE_COMPANION_SKILL: CompanionSkillDefinition = {
  name: "forge-self-improvement",
  description: "Save reusable workflows and tools via forge",
  content: [
    "# Forge — Self-Improvement",
    "",
    "You can save reusable knowledge as skills or tools using the forge system.",
    "",
    "## Available Tools",
    "",
    "- `forge_skill` — Save procedural knowledge (instructions, pitfalls, verification steps)",
    "- `forge_tool` — Save executable code (deterministic operations, fixed input → output)",
    "",
    "## Decision: Skill vs Tool",
    "",
    "- **Skill**: You need to explain WHEN and HOW to do something.",
    "  The knowledge includes judgment, conditional branching, pitfalls, verification.",
    "- **Tool**: You need to DO something the same way every time.",
    "  Fixed input → fixed output, no reasoning needed.",
    "",
    "## When to Create",
    "",
    "- You solved something that took 5+ tool calls",
    "- You recovered from an error in a non-obvious way",
    "- User corrected your approach — save the correction",
    "- You discovered a workflow worth reusing",
    "- You found a better approach than an existing skill",
    "",
    "## When NOT to Create",
    "",
    "- One-off tasks unlikely to recur",
    "- Trivial operations (< 3 steps)",
    "- Domain already well-covered by existing skills",
    "",
    "## Skill with Scripts",
    "",
    "When your workflow involved running specific commands, include them in the",
    "skill's `files` field under `scripts/`. The skill procedure references the",
    "scripts and provides judgment around when and how to use them.",
  ].join("\n"),
  tags: ["forge", "self-improvement", "learning"],
};

/**
 * Create a ComponentProvider that attaches the forge companion skill.
 */
export function createForgeCompanionSkillProvider(): ComponentProvider {
  return {
    name: "forge-companion-skill",

    attach: async (_agent: Agent): Promise<AttachResult> => {
      const components = new Map<string, unknown>();
      components.set(FORGE_SKILL_TOKEN, {
        name: FORGE_COMPANION_SKILL.name,
        description: FORGE_COMPANION_SKILL.description,
        content: FORGE_COMPANION_SKILL.content,
        tags: FORGE_COMPANION_SKILL.tags,
      });
      return { components, skipped: [] };
    },
  };
}
