/**
 * Self-forge companion skill — teaches the agent when and how to forge
 * new skills from its own ACE-learned playbooks.
 *
 * Attached as a CompanionSkillDefinition on the ACE BrickDescriptor
 * and auto-registered via registerCompanionSkills() at CLI startup.
 */

import type { CompanionSkillDefinition } from "@koi/core";

/**
 * Companion skill that guides agents through the self-improvement loop:
 * list_playbooks → analyze patterns → forge_skill / forge_tool.
 */
export const SELF_FORGE_SKILL: CompanionSkillDefinition = {
  name: "ace-self-forge",
  description:
    "When and how to analyze your own learned playbooks and forge them into reusable skills or tools",
  content: `# Auto-Forge from Playbooks

You have access to \`list_playbooks\` — a tool that shows patterns you've learned across sessions via ACE (Adaptive Continuous Enhancement).

## When to Analyze

- After 5+ sessions with active playbooks
- When a user asks "what have you learned?" or "what patterns do you see?"
- When you notice you're repeating a multi-step workflow
- Periodically during complex tasks to check for forge-worthy patterns

## How to Self-Forge

1. Call \`list_playbooks(minConfidence: 0.7)\` to see high-confidence patterns
2. Identify clusters: look for playbooks with similar tags or co-occurring patterns
3. For recurring multi-step workflows: call \`forge_skill\` to crystallize into a reusable skill
4. For reusable computations: call \`forge_tool\` to create a persistent tool
5. For one-off analysis: just use the insight directly without forging

## What Makes a Good Forged Skill

- Pattern appears across 3+ sessions (sessionCount >= 3)
- Confidence score above 0.7 (stat-based) or high helpful count (structured)
- Describes a workflow, not just a single tool preference
- Includes context about WHEN to apply (not just HOW)
- Has clear tags for discoverability

## What Makes a Good Forged Tool

- A computation or API call you've done manually 3+ times
- Something with clear inputs and outputs (good for a schema)
- A task that benefits from caching or persistence

## Anti-Patterns

- Do NOT forge every playbook — only high-value, recurring patterns
- Do NOT forge if sessionCount < 3 — wait for more evidence
- Do NOT duplicate an existing skill — use \`search_forge\` first
- Do NOT forge trivial patterns (single tool calls, obvious steps)
`,
  tags: ["ace", "self-improvement", "forge", "meta-learning"],
} as const satisfies CompanionSkillDefinition;
