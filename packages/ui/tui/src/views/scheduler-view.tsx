/**
 * Scheduler view — task queue, cron schedules, and dead letter queue.
 */

import { PanelChrome } from "../components/panel-chrome.js";
import type { SchedulerViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface SchedulerViewProps {
  readonly schedulerView: SchedulerViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function SchedulerView(props: SchedulerViewProps): React.ReactNode {
  const { stats, tasks, schedules, deadLetters, events, scrollOffset } = props.schedulerView;
  const VISIBLE_ROWS = 12;
  const visibleTasks = tasks.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Scheduler"
      count={tasks.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={stats === null && tasks.length === 0 && events.length === 0}
      emptyMessage="No scheduler data yet."
      emptyHint="The scheduler manages task queues and cron schedules."
    >
      {/* Stats bar */}
      {stats !== null && (
        <box height={1}>
          <text fg={COLORS.dim}>
            {` Submitted: ${String(stats.submitted)} │ Completed: ${String(stats.completed)} │ Failed: ${String(stats.failed)} │ DLQ: ${String(stats.deadLetterCount)} │ Concurrency: ${String(stats.currentConcurrency)}${stats.concurrencyLimit !== undefined ? `/${String(stats.concurrencyLimit)}` : ""}`}
          </text>
        </box>
      )}

      {/* Task queue */}
      <box flexDirection="column" marginTop={stats !== null ? 1 : 0}>
        <box height={1}>
          <text fg={COLORS.dim}>{" Task ID              Agent        Status       Priority  Retries"}</text>
        </box>
        {visibleTasks.map((task) => {
          const statusColor = task.status === "completed" ? COLORS.dim
            : task.status === "failed" || task.status === "dead_letter" ? COLORS.red
            : task.status === "running" ? COLORS.green
            : COLORS.white;
          return (
            <box key={task.taskId} height={1}>
              <text>
                {` ${task.taskId.padEnd(20).slice(0, 20)} ${task.agentId.padEnd(12).slice(0, 12)} `}
              </text>
              <text fg={statusColor}>{task.status.padEnd(12)}</text>
              <text>{` ${String(task.priority).padStart(2)}        ${String(task.retryCount)}`}</text>
            </box>
          );
        })}
      </box>

      {/* Cron schedules */}
      {schedules.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <box height={1}><text fg={COLORS.dim}>{` Schedules (${String(schedules.length)}):`}</text></box>
          {schedules.map((sched) => (
            <box key={sched.scheduleId} height={1}>
              <text>
                {`   ${sched.active ? "●" : "○"} ${sched.scheduleId.padEnd(16).slice(0, 16)} ${sched.pattern.padEnd(16)}`}
              </text>
              {sched.description !== undefined && (
                <text fg={COLORS.dim}>{` ${sched.description}`}</text>
              )}
            </box>
          ))}
        </box>
      )}

      {/* Dead letter queue */}
      {deadLetters.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <box height={1}>
            <text fg={COLORS.red}>{` Dead Letters (${String(deadLetters.length)}):`}</text>
          </box>
          {deadLetters.slice(0, 5).map((dl) => (
            <box key={dl.entryId} height={1}>
              <text fg={COLORS.dim}>
                {`   ${dl.taskId.padEnd(16).slice(0, 16)} retries: ${String(dl.retryCount)} — ${dl.error.slice(0, 40)}`}
              </text>
            </box>
          ))}
        </box>
      )}
    </PanelChrome>
  );
}
