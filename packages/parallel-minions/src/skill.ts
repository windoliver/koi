/**
 * Skill component for the parallel_task tool — teaches agents fan-out/fan-in patterns.
 *
 * L2 — imports from @koi/core only.
 */

import type { SkillComponent } from "@koi/core";

/** Skill component name. */
export const PARALLEL_MINIONS_SKILL_NAME = "parallel-minions" as const;

/**
 * Markdown content teaching agents the parallel delegation strategy.
 * Injected into the agent's context alongside the tool descriptor.
 */
export const PARALLEL_MINIONS_SKILL_CONTENT: string = `
# Parallel Task — concurrent subagent delegation strategy

## Overview

The \`parallel_task\` tool delegates multiple independent tasks to specialized subagents
running concurrently. Results are aggregated and returned together. Use this for fan-out
workloads where subtasks do not depend on each other.

## When to use parallel_task

- **Independent subtasks**: you have 2+ tasks that do not depend on each other's output
- **Throughput over latency**: total wall-clock time matters and concurrent execution
  reduces it significantly
- **Batch analysis**: reviewing multiple files, searching across multiple directories,
  or running the same check against several targets
- **Multi-perspective review**: getting feedback from different specialist agent types
  (security, performance, accessibility) on the same artifact

## When NOT to use parallel_task

- **Sequential dependencies**: if task B needs the output of task A, use \`task\` twice
  in sequence instead
- **Single task**: if you only have one subtask, use \`task\` — parallel_task adds
  unnecessary overhead for a single item
- **Complex DAG dependencies**: if tasks form a dependency graph (not a flat list),
  use the \`orchestrator\` tools instead — they support task ordering and retry
- **Very small tasks**: if each task is a simple lookup, doing them yourself inline
  is faster than the spawn overhead

## Task decomposition

Break work into independent, self-contained units:

1. **One concern per task**: "Review auth.ts for XSS" and "Review auth.ts for SQL injection"
   are better as two tasks than one vague "review auth.ts"
2. **Include full context**: each subagent only sees its own task description — include
   file paths, function names, and any constraints
3. **Consistent output format**: request the same structure from all tasks so aggregation
   is straightforward (e.g., "Return findings as a JSON array with severity and message")
4. **Right-size the batch**: each batch supports up to 50 tasks, but 5-15 is typical —
   more tasks mean more latency and token usage

## Execution strategies

The system supports three strategies that control how failures are handled:

- **best-effort** (default): all tasks run to completion; failures are reported but do not
  block other tasks. Best for analysis and review workloads
- **fail-fast**: abort remaining tasks on the first failure. Best when any single failure
  invalidates the entire batch
- **quorum**: succeed when a minimum number of tasks complete. Best for redundancy
  patterns (e.g., ask 3 agents, take the majority answer)

## Result aggregation

- Results arrive as an array matching the input task order
- Each result includes the task description, agent type, and either a success output
  or an error with details
- Summarize findings across all results — do not just echo raw output

## Error handling

- Individual task failures do not necessarily mean the whole batch failed (depends on strategy)
- Check each result's status independently
- For failed tasks: analyze the error, decide if a single retry via \`task\` is warranted
- For timeouts: the task was too large — break it down further or increase the duration
`.trim();

/**
 * Pre-built SkillComponent for parallel task delegation guidance.
 * Attached automatically by createParallelMinionsProvider alongside the tool.
 */
export const PARALLEL_MINIONS_SKILL: SkillComponent = {
  name: PARALLEL_MINIONS_SKILL_NAME,
  description:
    "When to use parallel delegation, how to decompose tasks, execution strategy selection, and result aggregation",
  content: PARALLEL_MINIONS_SKILL_CONTENT,
  tags: ["delegation", "parallel", "fan-out"],
} as const satisfies SkillComponent;
