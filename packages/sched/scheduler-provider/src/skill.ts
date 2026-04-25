export const SCHEDULER_SKILL_NAME: string = "scheduler-guide";

export const SCHEDULER_SKILL: string = `
# Scheduler Tools Guide

You have access to 9 scheduler tools for managing background tasks and recurring schedules.

## Tools Overview
- **scheduler_submit**: Run a task once (immediately or with delayMs)
- **scheduler_cancel**: Cancel a pending task
- **scheduler_schedule**: Create a recurring cron schedule
- **scheduler_unschedule**: Remove a cron schedule
- **scheduler_pause**: Pause a cron schedule temporarily
- **scheduler_resume**: Resume a paused cron schedule
- **scheduler_query**: List your tasks (filter by status, priority, limit)
- **scheduler_stats**: Count your tasks and schedules by status
- **scheduler_history**: View execution history (completed/failed runs)

## When to Use
- Use \`scheduler_submit\` for one-off tasks or tasks with a future start (delayMs).
- Use \`scheduler_schedule\` for recurring work (cron expressions: "0 9 * * 1" = every Monday 9am).
- Use \`scheduler_query\` to check task status before assuming completion.

## Modes
- \`spawn\`: Creates a new agent to handle the task.
- \`dispatch\`: Routes the task to an existing agent session.

## Cron Examples
- \`"0 * * * *"\` — every hour
- \`"0 9 * * 1-5"\` — weekdays at 9am
- \`"*/15 * * * *"\` — every 15 minutes

## Important
- Tasks are at-least-once: after a crash, tasks may re-run. Make inputs idempotent.
- Timed-out tasks go to dead_letter immediately (not retried).
- You can only manage your own tasks and schedules.
`.trim();
