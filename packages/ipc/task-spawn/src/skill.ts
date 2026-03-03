/**
 * Skill component for the task tool — teaches agents when and how to delegate work.
 *
 * L2 — imports from @koi/core only.
 */

import type { SkillComponent } from "@koi/core";

/** Skill component name. */
export const TASK_SPAWN_SKILL_NAME = "task-spawn" as const;

/**
 * Markdown content teaching agents the task delegation strategy.
 * Injected into the agent's context alongside the tool descriptor.
 */
export const TASK_SPAWN_SKILL_CONTENT: string = `
# Task — subagent delegation strategy

## Overview

The \`task\` tool delegates a self-contained unit of work to a specialized subagent.
The subagent runs independently, completes the work, and returns its final response.
Use this when a task is too large, too specialized, or too context-heavy to handle inline.

## When to use task

- **Context isolation**: the subtask requires reading many files or producing verbose output
  that would bloat your own context window
- **Specialization**: a specific agent type (e.g., code-reviewer, security-reviewer) is better
  suited for the work than you are
- **Separation of concerns**: the subtask is logically independent — its outcome does not
  depend on your in-progress reasoning
- **Long-running work**: the subtask may take significant processing that you do not need to
  watch synchronously

## When NOT to use task

- **Quick lookups**: if you can answer with a single tool call (file read, search), do it
  yourself — spawning a subagent adds latency
- **Tightly coupled reasoning**: if the subtask result immediately feeds into your next
  sentence, the round-trip overhead is wasteful
- **Parallel fan-out**: if you need multiple independent subtasks at once, use \`parallel_task\`
  instead — it runs them concurrently and aggregates results

## Writing good task descriptions

The description is the **only context** the subagent receives. Make it self-contained:

1. **State the goal clearly**: "Review the auth middleware in src/auth.ts for security issues"
2. **Include necessary context**: file paths, function names, constraints
3. **Specify the expected output**: "Return a list of findings with severity and fix suggestions"
4. **Avoid ambiguity**: do not say "fix the code" — say "fix the null-check bug on line 42 of src/parser.ts"

## Agent type selection

- Omit \`agent_type\` to use the default general-purpose agent
- Specify \`agent_type\` when a specialist exists (e.g., "code-reviewer", "security-reviewer")
- If unsure which types are available, omit — the system will fall back gracefully

## Error handling

- If the subagent fails or times out, you receive an error result — do not retry blindly
- Analyze the error: was the description unclear? Was the agent type wrong?
- Rephrase and retry once if the cause is fixable; escalate to the user if not
`.trim();

/**
 * Pre-built SkillComponent for task delegation guidance.
 * Attached automatically by createTaskSpawnProvider alongside the tool.
 */
export const TASK_SPAWN_SKILL: SkillComponent = {
  name: TASK_SPAWN_SKILL_NAME,
  description:
    "When to delegate work to subagents, how to write effective task descriptions, and how to select agent types",
  content: TASK_SPAWN_SKILL_CONTENT,
  tags: ["delegation", "subagent"],
} as const satisfies SkillComponent;
