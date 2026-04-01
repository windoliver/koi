/**
 * Skill component for the squash tool — teaches agents when and how to compress context.
 *
 * L2 — imports from @koi/core only.
 */

import type { SkillComponent } from "@koi/core";

/** Skill component name. */
export const SQUASH_SKILL_NAME = "squash" as const;

/**
 * Markdown content teaching agents the squash strategy.
 * Injected into the agent's context alongside the tool descriptor.
 */
export const SQUASH_SKILL_CONTENT: string = `
# Squash — context compression strategy

## When to call squash

Call \`squash\` at **natural phase boundaries** — moments where one logical phase ends
and a new one begins. Good triggers:

- **Phase transitions**: done planning → starting implementation, done researching → starting coding
- **High tool-call density**: after 10+ tool calls (file reads, searches, writes) since your last squash
- **Large intermediate output**: after reading multiple large files or receiving verbose tool results that you have already processed
- **Before a complex next step**: if the upcoming work needs room to think, compress first

## When NOT to call squash

- **Mid-task**: do not squash while actively debugging, editing, or iterating on a single file
- **Too early**: if you have fewer than ~8 messages, there is nothing meaningful to compress
- **Right before finishing**: if you are about to deliver the final answer, compression is wasted effort

## How to write a good summary

The summary **replaces** all old messages — it is the only record the model will see going forward.
Include:

1. **Key decisions made** and their rationale ("chose SQLite because user requested it")
2. **Files created or modified** with a brief note on what changed
3. **Current state** — what is done, what is next
4. **Unresolved issues** or open questions, if any

Do NOT include:
- Verbose file contents (they are archived and retrievable)
- Step-by-step narration of what you did (focus on outcomes)
- Temporary debug output or intermediate reasoning

## How to use facts

Facts are optional durable knowledge stored to long-term memory. Use them for truths
that matter **across sessions**, not just the current conversation:

- User preferences: "User prefers TypeScript strict mode", "User uses Bun, not Node"
- Project conventions: "API uses REST with JSON responses", "Tests use bun:test"
- Environmental info: "API key stored in .env", "Deploy target is Cloudflare Workers"

Do NOT store as facts:
- Temporary state ("currently editing foo.ts")
- Obvious information ("the project has a package.json")
- Anything specific to the current task that will not be relevant later
`.trim();

/**
 * Pre-built SkillComponent for squash behavioral guidance.
 * Attached automatically by createSquashProvider alongside the tool.
 */
export const SQUASH_SKILL: SkillComponent = {
  name: SQUASH_SKILL_NAME,
  description:
    "When to compress context with squash, how to write effective summaries, and how to extract durable facts",
  content: SQUASH_SKILL_CONTENT,
  tags: ["context-management", "compression"],
} as const satisfies SkillComponent;
