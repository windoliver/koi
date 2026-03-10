/**
 * Scheduler admin adapter for the Koi dashboard.
 *
 * Wraps a structurally-typed TaskScheduler to produce dashboard-compatible
 * views (RuntimeViewDataSource['scheduler']) and commands (pauseSchedule,
 * resumeSchedule, deleteSchedule, retrySchedulerDeadLetter).
 *
 * Uses structural typing to avoid direct dependency on @koi/scheduler —
 * the consumer injects a compatible scheduler at runtime.
 *
 * L2 package: imports from @koi/core and @koi/dashboard-types only.
 */

import type { KoiError, Result } from "@koi/core";
import type {
  CommandDispatcher,
  CronSchedule as DashboardCronSchedule,
  SchedulerStats as DashboardSchedulerStats,
  RuntimeViewDataSource,
  SchedulerDeadLetterEntry,
  SchedulerTaskSummary,
} from "@koi/dashboard-types";

// ---------------------------------------------------------------------------
// Structural types (loose coupling — no @koi/scheduler import)
// ---------------------------------------------------------------------------

/** Minimal shape of a scheduled task from the core scheduler. */
export interface ScheduledTaskLike {
  readonly id: string;
  readonly agentId: string;
  readonly status: "pending" | "running" | "completed" | "failed" | "dead_letter";
  readonly priority: number;
  readonly createdAt: number;
  readonly startedAt?: number | undefined;
  readonly completedAt?: number | undefined;
  readonly retries: number;
  readonly lastError?: { readonly message: string } | undefined;
}

/** Minimal shape of a cron schedule from the core scheduler. */
export interface CronScheduleLike {
  readonly id: string;
  readonly expression: string;
  readonly paused: boolean;
  readonly agentId: string;
}

/** Minimal shape of scheduler stats from the core scheduler. */
export interface SchedulerStatsLike {
  readonly pending: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly deadLettered: number;
  readonly activeSchedules: number;
  readonly pausedSchedules: number;
}

/** Structural interface for the backing TaskScheduler. */
export interface SchedulerAdminClientLike {
  readonly query: (filter: {
    readonly status?: string | undefined;
  }) => readonly ScheduledTaskLike[] | Promise<readonly ScheduledTaskLike[]>;
  readonly stats: () => SchedulerStatsLike | Promise<SchedulerStatsLike>;
  /** Pause a cron schedule by ID. Returns true if paused. */
  readonly pause?: ((id: string) => boolean | Promise<boolean>) | undefined;
  /** Resume a cron schedule by ID. Returns true if resumed. */
  readonly resume?: ((id: string) => boolean | Promise<boolean>) | undefined;
  /** Remove a cron schedule by ID. Returns true if removed. */
  readonly unschedule?: ((id: string) => boolean | Promise<boolean>) | undefined;
}

/** Extended interface that includes cron schedule listing. */
export interface SchedulerAdminClientWithSchedules extends SchedulerAdminClientLike {
  readonly listSchedules: () => readonly CronScheduleLike[] | Promise<readonly CronScheduleLike[]>;
}

// ---------------------------------------------------------------------------
// Adapter result
// ---------------------------------------------------------------------------

export interface SchedulerAdminAdapter {
  readonly views: NonNullable<RuntimeViewDataSource["scheduler"]>;
  readonly commands: Pick<
    CommandDispatcher,
    "pauseSchedule" | "resumeSchedule" | "deleteSchedule" | "retrySchedulerDeadLetter"
  >;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapTaskToSummary(task: ScheduledTaskLike): SchedulerTaskSummary {
  return {
    taskId: task.id,
    agentId: task.agentId,
    status: task.status,
    priority: task.priority,
    submittedAt: task.createdAt,
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
    retryCount: task.retries,
  };
}

function mapScheduleToDashboard(schedule: CronScheduleLike): DashboardCronSchedule {
  return {
    scheduleId: schedule.id,
    pattern: schedule.expression,
    nextFireTime: 0, // Not available from core type
    active: !schedule.paused,
  };
}

function mapStatsToDashboard(stats: SchedulerStatsLike): DashboardSchedulerStats {
  return {
    submitted: stats.pending + stats.running + stats.completed + stats.failed + stats.deadLettered,
    completed: stats.completed,
    failed: stats.failed,
    deadLetterCount: stats.deadLettered,
    concurrencyLimit: 0, // Not available from stats alone
    currentConcurrency: stats.running,
  };
}

function mapDeadLetterEntry(task: ScheduledTaskLike): SchedulerDeadLetterEntry {
  return {
    entryId: task.id,
    taskId: task.id,
    failedAt: task.completedAt ?? task.createdAt,
    error: task.lastError?.message ?? "Unknown error",
    retryCount: task.retries,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSchedulerAdminAdapter(
  client: SchedulerAdminClientLike,
): SchedulerAdminAdapter {
  const hasSchedules = "listSchedules" in client && typeof client.listSchedules === "function";

  const views: NonNullable<RuntimeViewDataSource["scheduler"]> = {
    async listTasks(): Promise<readonly SchedulerTaskSummary[]> {
      const tasks = await client.query({});
      return tasks.map(mapTaskToSummary);
    },

    async getStats(): Promise<DashboardSchedulerStats> {
      const stats = await client.stats();
      return mapStatsToDashboard(stats);
    },

    async listSchedules(): Promise<readonly DashboardCronSchedule[]> {
      if (!hasSchedules) return [];
      const schedules = await (client as SchedulerAdminClientWithSchedules).listSchedules();
      return schedules.map(mapScheduleToDashboard);
    },

    async listDeadLetters(): Promise<readonly SchedulerDeadLetterEntry[]> {
      const tasks = await client.query({ status: "dead_letter" });
      return tasks.map(mapDeadLetterEntry);
    },
  };

  // Capture supported operations — only provide commands the client supports.
  // When omitted, the route handler returns 501 and the UI hides the button.
  const pauseFn = client.pause;
  const resumeFn = client.resume;
  const unscheduleFn = client.unschedule;

  const commands: SchedulerAdminAdapter["commands"] = {
    ...(pauseFn !== undefined
      ? {
          async pauseSchedule(id: string): Promise<Result<void, KoiError>> {
            const ok = await pauseFn(id);
            if (!ok) {
              return {
                ok: false,
                error: { code: "NOT_FOUND", message: `Schedule ${id} not found`, retryable: false },
              };
            }
            return { ok: true, value: undefined };
          },
        }
      : {}),

    ...(resumeFn !== undefined
      ? {
          async resumeSchedule(id: string): Promise<Result<void, KoiError>> {
            const ok = await resumeFn(id);
            if (!ok) {
              return {
                ok: false,
                error: { code: "NOT_FOUND", message: `Schedule ${id} not found`, retryable: false },
              };
            }
            return { ok: true, value: undefined };
          },
        }
      : {}),

    ...(unscheduleFn !== undefined
      ? {
          async deleteSchedule(id: string): Promise<Result<void, KoiError>> {
            const ok = await unscheduleFn(id);
            if (!ok) {
              return {
                ok: false,
                error: { code: "NOT_FOUND", message: `Schedule ${id} not found`, retryable: false },
              };
            }
            return { ok: true, value: undefined };
          },
        }
      : {}),

    // Dead letter retry is a re-submit — not directly supported by core scheduler.
    // Omitted so the route handler returns 501 and the UI hides the Retry button.
  };

  return { views, commands };
}
