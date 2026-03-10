/**
 * SchedulerTab — 3-column kanban (Pending/Running/Done), cron schedules, DLQ.
 *
 * Pure CSS grid layout (Decision: no dnd-kit for read-only Phase 2).
 */

import type {
  CronSchedule,
  SchedulerDeadLetterEntry,
  SchedulerStats,
  SchedulerTaskSummary,
} from "@koi/dashboard-types";
import { useCallback } from "react";
import { useRuntimeView } from "../../hooks/use-runtime-view.js";
import {
  deleteSchedule,
  pauseSchedule,
  resumeSchedule,
  retrySchedulerDlq,
} from "../../lib/api-client.js";
import { formatRelativeTime } from "../../lib/format.js";
import { useOrchestrationStore } from "../../stores/orchestration-store.js";
import { LoadingSkeleton } from "../shared/loading-skeleton.js";

// ---------------------------------------------------------------------------
// Stats bar
// ---------------------------------------------------------------------------

function StatsBar({ stats }: { readonly stats: SchedulerStats }): React.ReactElement {
  return (
    <div className="grid grid-cols-3 gap-2">
      {[
        { label: "Submitted", value: stats.submitted },
        { label: "Completed", value: stats.completed },
        { label: "Failed", value: stats.failed },
        { label: "DLQ", value: stats.deadLetterCount },
        { label: "Concurrency", value: `${stats.currentConcurrency}/${stats.concurrencyLimit}` },
      ].map((item) => (
        <div
          key={item.label}
          className="rounded border border-[var(--color-border,#444)] px-3 py-2 text-center"
        >
          <div className="text-xs text-[var(--color-muted,#888)]">{item.label}</div>
          <div className="text-sm font-semibold text-[var(--color-foreground,#cdd6f4)]">
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kanban
// ---------------------------------------------------------------------------

const COLUMN_STYLES: Readonly<Record<string, string>> = {
  pending: "border-l-yellow-400",
  running: "border-l-blue-400",
  completed: "border-l-green-400",
  failed: "border-l-red-400",
  dead_letter: "border-l-red-600",
} as const;

function TaskCard({ task }: { readonly task: SchedulerTaskSummary }): React.ReactElement {
  const borderClass = COLUMN_STYLES[task.status] ?? "border-l-[var(--color-border,#444)]";
  return (
    <div className={`rounded border border-[var(--color-border,#333)] border-l-4 ${borderClass} bg-[var(--color-card,#313244)] px-3 py-2`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-[var(--color-foreground,#cdd6f4)]">
          {task.taskId.slice(0, 12)}
        </span>
        <span className="text-xs text-[var(--color-muted,#888)]">P{task.priority}</span>
      </div>
      <div className="mt-1 text-xs text-[var(--color-muted,#888)]">
        {formatRelativeTime(task.submittedAt)}
        {task.retryCount > 0 && ` · ${task.retryCount} retries`}
      </div>
    </div>
  );
}

function KanbanColumn({
  title,
  tasks,
}: {
  readonly title: string;
  readonly tasks: readonly SchedulerTaskSummary[];
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--color-muted,#888)]">{title}</span>
        <span className="rounded-full bg-[var(--color-card,#313244)] px-2 py-0.5 text-xs text-[var(--color-muted,#888)]">
          {tasks.length}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {tasks.length > 0 ? (
          tasks.map((t) => <TaskCard key={t.taskId} task={t} />)
        ) : (
          <div className="rounded border border-dashed border-[var(--color-border,#444)] px-3 py-4 text-center text-xs text-[var(--color-muted,#666)]">
            Empty
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cron schedules
// ---------------------------------------------------------------------------

function ScheduleRow({
  schedule,
  onPause,
  onResume,
  onDelete,
}: {
  readonly schedule: CronSchedule;
  readonly onPause: (id: string) => void;
  readonly onResume: (id: string) => void;
  readonly onDelete: (id: string) => void;
}): React.ReactElement {
  return (
    <tr className="border-b border-[var(--color-border,#333)] hover:bg-[var(--color-card,#313244)]">
      <td className="px-3 py-2 text-xs font-mono text-[var(--color-foreground,#cdd6f4)]">
        {schedule.pattern}
      </td>
      <td className="px-3 py-2 text-xs text-[var(--color-muted,#888)]">
        {new Date(schedule.nextFireTime).toLocaleTimeString()}
      </td>
      <td className={`px-3 py-2 text-xs font-medium ${schedule.active ? "text-green-400" : "text-yellow-400"}`}>
        {schedule.active ? "Active" : "Paused"}
      </td>
      <td className="px-3 py-2 text-xs">
        <div className="flex gap-1">
          {schedule.active ? (
            <button
              type="button"
              className="rounded bg-yellow-600/20 px-2 py-0.5 text-xs text-yellow-400 hover:bg-yellow-600/30"
              onClick={() => onPause(schedule.scheduleId)}
            >
              Pause
            </button>
          ) : (
            <button
              type="button"
              className="rounded bg-green-600/20 px-2 py-0.5 text-xs text-green-400 hover:bg-green-600/30"
              onClick={() => onResume(schedule.scheduleId)}
            >
              Resume
            </button>
          )}
          <button
            type="button"
            className="rounded bg-red-600/20 px-2 py-0.5 text-xs text-red-400 hover:bg-red-600/30"
            onClick={() => onDelete(schedule.scheduleId)}
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// DLQ section
// ---------------------------------------------------------------------------

function DlqRow({
  entry,
  onRetry,
}: {
  readonly entry: SchedulerDeadLetterEntry;
  readonly onRetry: (id: string) => void;
}): React.ReactElement {
  return (
    <tr className="border-b border-[var(--color-border,#333)] hover:bg-[var(--color-card,#313244)]">
      <td className="px-3 py-2 text-xs font-mono text-[var(--color-foreground,#cdd6f4)]">
        {entry.taskId.slice(0, 12)}
      </td>
      <td className="max-w-[200px] truncate px-3 py-2 text-xs text-red-400">
        {entry.error}
      </td>
      <td className="px-3 py-2 text-xs text-[var(--color-muted,#888)]">
        {entry.retryCount}
      </td>
      <td className="px-3 py-2 text-xs">
        <button
          type="button"
          className="rounded bg-blue-600/20 px-2 py-0.5 text-xs text-blue-400 hover:bg-blue-600/30"
          onClick={() => onRetry(entry.entryId)}
        >
          Retry
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main tab
// ---------------------------------------------------------------------------

export function SchedulerTab(): React.ReactElement {
  const lastInvalidatedAt = useOrchestrationStore((s) => s.lastInvalidatedAt);

  const { data: stats, isLoading: statsLoading } = useRuntimeView<SchedulerStats>(
    "/scheduler/stats",
    { refetchInterval: 5_000, invalidationKey: lastInvalidatedAt },
  );
  const { data: tasks, isLoading: tasksLoading } = useRuntimeView<readonly SchedulerTaskSummary[]>(
    "/scheduler/tasks",
    { refetchInterval: 5_000, invalidationKey: lastInvalidatedAt },
  );
  const { data: schedules, isLoading: schedLoading, refetch: refetchSchedules } = useRuntimeView<readonly CronSchedule[]>(
    "/scheduler/schedules",
    { refetchInterval: 10_000, invalidationKey: lastInvalidatedAt },
  );
  const { data: dlq, isLoading: dlqLoading, refetch: refetchDlq } = useRuntimeView<readonly SchedulerDeadLetterEntry[]>(
    "/scheduler/dlq",
    { refetchInterval: 10_000, invalidationKey: lastInvalidatedAt },
  );

  const handlePauseSchedule = useCallback((id: string) => {
    void pauseSchedule(id).then(() => refetchSchedules());
  }, [refetchSchedules]);

  const handleResumeSchedule = useCallback((id: string) => {
    void resumeSchedule(id).then(() => refetchSchedules());
  }, [refetchSchedules]);

  const handleDeleteSchedule = useCallback((id: string) => {
    void deleteSchedule(id).then(() => refetchSchedules());
  }, [refetchSchedules]);

  const handleRetryDlq = useCallback((id: string) => {
    void retrySchedulerDlq(id).then(() => refetchDlq());
  }, [refetchDlq]);

  if (statsLoading || tasksLoading) {
    return <div className="p-4"><LoadingSkeleton /></div>;
  }

  const allTasks = tasks ?? [];
  const pending = allTasks.filter((t) => t.status === "pending");
  const running = allTasks.filter((t) => t.status === "running");
  const done = allTasks.filter((t) => t.status === "completed" || t.status === "failed");

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Stats */}
      {stats !== undefined && <StatsBar stats={stats} />}

      {/* Kanban */}
      <div className="grid grid-cols-3 gap-3">
        <KanbanColumn title="Pending" tasks={pending} />
        <KanbanColumn title="Running" tasks={running} />
        <KanbanColumn title="Done" tasks={done} />
      </div>

      {/* Cron Schedules */}
      {!schedLoading && schedules !== undefined && schedules.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-medium text-[var(--color-muted,#888)]">Cron Schedules</h3>
          <div className="rounded border border-[var(--color-border,#444)]">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--color-border,#444)] bg-[var(--color-card,#313244)]">
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--color-muted,#888)]">Pattern</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--color-muted,#888)]">Next Fire</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--color-muted,#888)]">Status</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--color-muted,#888)]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <ScheduleRow
                    key={s.scheduleId}
                    schedule={s}
                    onPause={handlePauseSchedule}
                    onResume={handleResumeSchedule}
                    onDelete={handleDeleteSchedule}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* DLQ */}
      {!dlqLoading && dlq !== undefined && dlq.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-medium text-red-400">Dead Letter Queue ({dlq.length})</h3>
          <div className="rounded border border-[var(--color-border,#444)]">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--color-border,#444)] bg-[var(--color-card,#313244)]">
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--color-muted,#888)]">Task</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--color-muted,#888)]">Error</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--color-muted,#888)]">Retries</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-[var(--color-muted,#888)]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {dlq.map((entry) => (
                  <DlqRow key={entry.entryId} entry={entry} onRetry={handleRetryDlq} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
