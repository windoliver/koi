/**
 * createSchedulerComponent — agent-scoped wrapper around TaskScheduler.
 *
 * Pins an AgentId to all operations and enforces ownership:
 * - submit/query/history/stats are automatically scoped to the pinned agent
 * - cancel/unschedule/pause/resume reject foreign IDs by returning false
 */

import type {
  AgentId,
  EngineInput,
  ScheduledTask,
  ScheduleId,
  SchedulerComponent,
  SchedulerStats,
  TaskFilter,
  TaskHistoryFilter,
  TaskId,
  TaskOptions,
  TaskRunRecord,
  TaskScheduler,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSchedulerComponent(
  scheduler: TaskScheduler,
  pinnedAgentId: AgentId,
): SchedulerComponent {
  // Tracks ScheduleIds created by this component instance for ownership checks.
  const ownedScheduleIds = new Set<ScheduleId>();
  // Tracks paused state for owned schedules.
  const pausedScheduleIds = new Set<ScheduleId>();

  async function submit(
    input: EngineInput,
    mode: "spawn" | "dispatch",
    options?: TaskOptions,
  ): Promise<TaskId> {
    return scheduler.submit(pinnedAgentId, input, mode, options);
  }

  async function cancel(id: TaskId): Promise<boolean> {
    // Ownership check: task must belong to this agent.
    const tasks = await scheduler.query({ agentId: pinnedAgentId });
    const owned = tasks.some((t: ScheduledTask) => t.id === id);
    if (!owned) return false;
    return scheduler.cancel(id);
  }

  async function schedule(
    expression: string,
    input: EngineInput,
    mode: "spawn" | "dispatch",
    options?: TaskOptions & { readonly timezone?: string | undefined },
  ): Promise<ScheduleId> {
    const sid = await scheduler.schedule(expression, pinnedAgentId, input, mode, options);
    ownedScheduleIds.add(sid);
    return sid;
  }

  async function unschedule(id: ScheduleId): Promise<boolean> {
    if (!ownedScheduleIds.has(id)) return false;
    const result = await scheduler.unschedule(id);
    if (result) {
      ownedScheduleIds.delete(id);
      pausedScheduleIds.delete(id);
    }
    return result;
  }

  async function pause(id: ScheduleId): Promise<boolean> {
    if (!ownedScheduleIds.has(id)) return false;
    const result = await scheduler.pause(id);
    if (result) pausedScheduleIds.add(id);
    return result;
  }

  async function resume(id: ScheduleId): Promise<boolean> {
    if (!ownedScheduleIds.has(id)) return false;
    const result = await scheduler.resume(id);
    if (result) pausedScheduleIds.delete(id);
    return result;
  }

  async function query(filter: TaskFilter): Promise<readonly ScheduledTask[]> {
    return scheduler.query({ ...filter, agentId: pinnedAgentId });
  }

  async function stats(): Promise<SchedulerStats> {
    const tasks = await scheduler.query({ agentId: pinnedAgentId });
    let pending = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const task of tasks) {
      switch (task.status) {
        case "pending":
          pending++;
          break;
        case "running":
          running++;
          break;
        case "completed":
          completed++;
          break;
        case "failed":
          failed++;
          break;
        case "dead_letter":
          deadLettered++;
          break;
      }
    }

    const activeSchedules = ownedScheduleIds.size - pausedScheduleIds.size;
    const pausedSchedules = pausedScheduleIds.size;

    return {
      pending,
      running,
      completed,
      failed,
      deadLettered,
      activeSchedules,
      pausedSchedules,
    };
  }

  async function history(filter: TaskHistoryFilter): Promise<readonly TaskRunRecord[]> {
    return scheduler.history({ ...filter, agentId: pinnedAgentId });
  }

  return { submit, cancel, schedule, unschedule, pause, resume, query, stats, history };
}
