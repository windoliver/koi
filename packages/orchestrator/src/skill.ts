/**
 * Skill component for the orchestrator tools — teaches agents multi-step workflow coordination.
 *
 * L2 — imports from @koi/core only.
 */

import type { SkillComponent } from "@koi/core";

/** Skill component name. */
export const ORCHESTRATOR_SKILL_NAME = "orchestrator" as const;

/**
 * Markdown content teaching agents the orchestrator workflow.
 * Injected into the agent's context alongside the tool descriptors.
 */
export const ORCHESTRATOR_SKILL_CONTENT: string = `
# Orchestrator — multi-step workflow coordination

## Overview

The orchestrator provides a persistent task board with DAG-based dependency tracking.
Four tools work together: \`orchestrate\` (plan), \`assign_worker\` (execute),
\`review_output\` (verify), and \`synthesize\` (combine). Use this for complex,
multi-step workflows where tasks have dependencies and may need retry or revision.

## The four-tool workflow

### 1. orchestrate — plan the work

Use action \`add\` to populate the task board with tasks and their dependencies:

- Each task has an ID, description, and optional \`depends_on\` list
- Dependencies form a DAG — cycles are rejected
- Use action \`query\` to inspect the current board state at any time
- Use action \`update\` to modify task descriptions or dependencies

Plan thoroughly before assigning workers. A well-structured board prevents rework.

### 2. assign_worker — execute ready tasks

Assign tasks whose dependencies are all completed:

- Only tasks in "ready" state (all deps satisfied) can be assigned
- Each assignment spawns a worker subagent that executes the task
- Workers run independently — you can assign multiple ready tasks concurrently
- The worker receives the task description as its sole context

### 3. review_output — verify results

After a worker completes, review its output:

- **accept**: the output meets requirements — mark the task as completed
- **reject**: the output is wrong — the task enters "failed" state and may be retried
  up to the configured maxRetries
- **revise**: the output needs improvement — provide feedback and retry with the
  worker receiving your revision notes

Always review before accepting. Blindly accepting defeats the purpose of orchestration.

### 4. synthesize — combine results

Once all tasks are completed, synthesize produces a final output:

- Results are ordered topologically (dependency order)
- The synthesis should integrate and summarize — not just concatenate
- Only call synthesize when the board is complete (all tasks accepted)

## When to use orchestrator

- **Complex multi-step workflows**: 4+ tasks with interdependencies
- **Quality gates**: work that needs review before downstream tasks can proceed
- **Retry patterns**: tasks that may fail and need revision with feedback
- **Pipeline coordination**: sequential phases where each phase depends on the prior

## When NOT to use orchestrator

- **Independent tasks**: if no task depends on another, use \`parallel_task\` instead —
  less ceremony, same concurrency
- **Single delegation**: for one task, use \`task\` — orchestrator overhead is not justified
- **Simple sequential**: if you just need A-then-B with no branching, call \`task\` twice

## DAG design patterns

### Linear pipeline
\`\`\`
research → implement → test → review
\`\`\`

### Fan-out / fan-in
\`\`\`
analyze → [security_check, perf_check, lint_check] → synthesize_report
\`\`\`

### Diamond dependency
\`\`\`
parse → [validate_schema, validate_data] → merge_results
\`\`\`

## Error handling

- **Worker failure**: review the error, provide clearer instructions via \`revise\`, retry
- **Dependency failure**: downstream tasks cannot start — fix the upstream task first
- **Timeout**: the orchestration has a global timeout — plan tasks to fit within it
- **Cycle detection**: the board rejects circular dependencies at add-time — restructure
  your task graph if this occurs
- **Max retries exceeded**: if a task fails beyond maxRetries, it enters a terminal failed
  state — consider restructuring the task or handling the failure in synthesis
`.trim();

/**
 * Pre-built SkillComponent for orchestrator workflow guidance.
 * Attached automatically by createOrchestratorProvider alongside the tools.
 */
export const ORCHESTRATOR_SKILL: SkillComponent = {
  name: ORCHESTRATOR_SKILL_NAME,
  description:
    "Four-tool orchestration workflow, DAG patterns, task board lifecycle, and retry/revision strategies",
  content: ORCHESTRATOR_SKILL_CONTENT,
  tags: ["orchestration", "workflow", "dag", "coordination"],
} as const satisfies SkillComponent;
