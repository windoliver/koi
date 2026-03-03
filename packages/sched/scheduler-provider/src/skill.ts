/**
 * Skill component for the scheduler tools — teaches agents task scheduling patterns.
 *
 * L2 — imports from @koi/core only.
 */

import type { SkillComponent } from "@koi/core";

/** Skill component name. */
export const SCHEDULER_SKILL_NAME = "scheduler" as const;

/**
 * Markdown content teaching agents the scheduling workflow.
 * Injected into the agent's context alongside the tool descriptors.
 */
export const SCHEDULER_SKILL_CONTENT: string = `
# Scheduler — task scheduling and lifecycle management

## Overview

The scheduler provides 9 tools for submitting, scheduling, and managing tasks.
Tasks can be one-shot (submit) or recurring (schedule with cron expressions).
All operations are scoped to your agent identity — you can only manage your own tasks.

## Tool selection guide

| Need | Tool | Notes |
|------|------|-------|
| Run a task now | \`sched_submit\` | One-shot immediate execution |
| Run a task later | \`sched_submit\` with \`delayMs\` | Deferred one-shot |
| Run a task on a schedule | \`sched_schedule\` | Cron-based recurring |
| Stop a running/pending task | \`sched_cancel\` | Cancels one-shot tasks |
| Remove a recurring schedule | \`sched_unschedule\` | Permanently removes the schedule |
| Temporarily stop a schedule | \`sched_pause\` | Schedule remains, stops firing |
| Re-enable a paused schedule | \`sched_resume\` | Resumes from next cron tick |
| Check current tasks | \`sched_query\` | Filter by status, priority |
| View aggregate stats | \`sched_stats\` | Counts by status |
| View past executions | \`sched_history\` | Historical run records |

## When to use the scheduler

- **Deferred work**: tasks that should run at a specific time or after a delay
- **Recurring operations**: periodic checks, reports, data syncs, cleanup jobs
- **Background processing**: work that does not need an immediate response
- **Task lifecycle management**: tracking, pausing, resuming, and cancelling work

## When NOT to use the scheduler

- **Immediate inline work**: if you need the result right now, do it directly or use \`task\`
- **One-time delegation**: for a single immediate task, \`task\` is simpler than submit
- **Complex dependencies**: for multi-step workflows with dependencies, use \`orchestrator\`

## Cron expression patterns

Common cron patterns (\`minute hour day-of-month month day-of-week\`):

- Every hour: \`0 * * * *\`
- Daily at midnight: \`0 0 * * *\`
- Every weekday at 9am: \`0 9 * * 1-5\`
- Every 15 minutes: \`*/15 * * * *\`
- Monthly on the 1st: \`0 0 1 * *\`

Timezone defaults to UTC — specify \`timezone\` for local-time schedules.

## Execution modes

- **spawn**: creates a new agent instance for each execution — fully isolated,
  no shared state between runs
- **dispatch**: sends work to an existing agent — shares state, useful for
  agents that maintain context across tasks

Choose \`spawn\` for stateless tasks and \`dispatch\` for stateful tasks.

## Pause and resume patterns

Use pause/resume for temporary schedule suspension:

- Maintenance windows: pause schedules during deploys, resume after
- Rate limiting: pause when approaching API quotas, resume when quota resets
- Manual override: pause automated work while handling an incident

## Error handling

- **Submit failures**: check the returned taskId — if the scheduler rejected the task,
  the input may be malformed or the scheduler may be at capacity
- **Cron parse errors**: verify your expression matches 5-field cron syntax
- **Cancel on non-existent task**: returns false — the task may have already completed
- **Query returns empty**: no tasks match the filter — check the status filter
- **Task retries**: tasks with \`maxRetries > 0\` automatically retry on failure —
  check history to see retry attempts and outcomes
`.trim();

/**
 * Pre-built SkillComponent for scheduler workflow guidance.
 * Attached automatically by createSchedulerProvider alongside the tools.
 */
export const SCHEDULER_SKILL: SkillComponent = {
  name: SCHEDULER_SKILL_NAME,
  description:
    "Task scheduling with cron expressions, tool selection guide, execution modes, and lifecycle management",
  content: SCHEDULER_SKILL_CONTENT,
  tags: ["scheduling", "cron", "lifecycle", "background-tasks"],
} as const satisfies SkillComponent;
