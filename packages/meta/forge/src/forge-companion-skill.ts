/**
 * Forge companion skill — teaches the model when and how to use forge tools.
 *
 * Attached as a SkillComponent when forge is enabled. Provides guidance on:
 * - When to create a skill vs a tool
 * - What kinds of workflows are worth saving
 * - How to include helper scripts under `files` / `scripts`
 */

import type { SkillComponent } from "@koi/core";

/**
 * Static companion skill for the forge subsystem.
 *
 * Follows the "Exposing a Skill" recipe from the architecture doc:
 * a const SkillComponent attached via extras on the forge provider.
 */
export const FORGE_COMPANION_SKILL: SkillComponent = {
  name: "forge-companion",
  description: "When and how to create reusable tools, skills, and agents with the forge system",
  content: `# Forge Companion

You have access to the forge system — a set of tools for creating reusable capabilities at runtime.

## When to Forge

**Create a tool** when:
- You need to call an external API or execute code that doesn't exist yet
- A specific computation or data transformation is needed repeatedly
- The capability requires executable implementation (not just instructions)

**Create a skill** when:
- You've discovered a workflow, process, or technique worth remembering
- The user corrects you — save the correction as reusable knowledge
- A complex task succeeds and the approach should be preserved for next time
- The knowledge is instructional (prompt + guidance) rather than executable

**Do NOT forge** when:
- The task is a one-off that won't recur
- An existing tool or skill already covers the capability (search first!)
- The capability gap is due to a temporary error, not a missing feature

## Workflow

1. **Search first**: Always use \`search_forge\` before creating — avoid duplicates
2. **Create**: Use \`forge_tool\` for executable tools, \`forge_skill\` for knowledge
3. **Iterate**: Use \`forge_edit\` to refine existing bricks based on feedback
4. **Promote**: Use \`promote_forge\` to widen visibility (agent → zone → global)

## Skill Structure

When creating a skill, include:
- Clear title and description
- Step-by-step instructions or decision criteria
- Examples of when to apply (and when NOT to)
- Tags for discoverability

## Tool Structure

When creating a tool, include:
- Precise input schema with descriptions
- At least 2 test cases (happy path + error case)
- Tags for discoverability
- \`files\` for helper scripts if the tool needs supporting code

## Visibility

- **Agent scope**: Only you can see it (default for new bricks)
- **Zone scope**: All agents in the same zone can see it
- **Global scope**: All agents can see it — promote carefully
`,
  tags: ["forge", "self-extension", "meta"],
} as const satisfies SkillComponent;
