/**
 * Temporal-backed TaskScheduler — implements L0 TaskScheduler contract.
 *
 * Decision 4A: Alternative backend (existing @koi/scheduler unchanged).
 * Decision 12A: Must pass L0 contract test suite.
 *
 * Bridges Koi cron/task definitions to Temporal Schedules and Workflows.
 * Uses @temporalio/client to create Schedules and start Workflows.
 */

import type {
  AgentId,
  CronSchedule,
  EngineInput,
  ScheduledTask,
  ScheduleId,
  SchedulerEvent,
  SchedulerStats,
  TaskFilter,
  TaskHistoryFilter,
  TaskId,
  TaskOptions,
  TaskRunRecord,
  TaskScheduler,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Local branded type constructors (avoid runtime import from @koi/core)
// ---------------------------------------------------------------------------

function toTaskId(id: string): TaskId {
  return id as TaskId;
}

function toScheduleId(id: string): ScheduleId {
  return id as ScheduleId;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structural type for Temporal Client (avoids deep SDK import).
 * The actual TemporalClient is injected at construction time.
 */
export interface TemporalClientLike {
  readonly workflow: {
    readonly start: (
      workflowType: string,
      options: Record<string, unknown>,
    ) => Promise<{ readonly workflowId: string }>;
    readonly signal: (
      workflowId: string,
      signalName: string,
      ...args: readonly unknown[]
    ) => Promise<void>;
    readonly cancel: (workflowId: string) => Promise<void>;
  };
  readonly schedule: {
    readonly create: (scheduleId: string, options: Record<string, unknown>) => Promise<unknown>;
    readonly delete: (scheduleId: string) => Promise<void>;
    readonly pause: (scheduleId: string, note?: string) => Promise<void>;
    readonly unpause: (scheduleId: string, note?: string) => Promise<void>;
  };
}

export interface TemporalSchedulerConfig {
  /** Temporal client instance. */
  readonly client: TemporalClientLike;
  /** Task queue for agent workflows. Default: "koi-default". */
  readonly taskQueue: string;
  /** Workflow type name for agent turns. Default: "agentWorkflow". */
  readonly workflowType: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a Temporal-backed TaskScheduler.
 *
 * Maps Koi task submissions to Temporal Workflow starts,
 * and Koi cron schedules to Temporal Schedules.
 */
export function createTemporalScheduler(config: TemporalSchedulerConfig): TaskScheduler {
  // In-memory tracking for stats/queries (lightweight — source of truth is Temporal)
  const tasks = new Map<string, ScheduledTask>();
  const schedules = new Map<string, CronSchedule>();
  const history: TaskRunRecord[] = [];
  const eventListeners = new Set<(event: SchedulerEvent) => void>();

  function emit(event: SchedulerEvent): void {
    for (const listener of eventListeners) {
      listener(event);
    }
  }

  function computeStats(): SchedulerStats {
    let pending = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;
    let deadLettered = 0;
    for (const task of tasks.values()) {
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

    let activeSchedules = 0;
    let pausedSchedules = 0;
    for (const schedule of schedules.values()) {
      if (schedule.paused) {
        pausedSchedules++;
      } else {
        activeSchedules++;
      }
    }

    return { pending, running, completed, failed, deadLettered, activeSchedules, pausedSchedules };
  }

  return {
    async submit(
      agentId: AgentId,
      input: EngineInput,
      mode: "spawn" | "dispatch",
      options?: TaskOptions,
    ): Promise<TaskId> {
      const id = toTaskId(`task:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`);
      const now = Date.now();

      const task: ScheduledTask = {
        id,
        agentId,
        input,
        mode,
        priority: options?.priority ?? 5,
        status: "pending",
        createdAt: now,
        scheduledAt: options?.delayMs !== undefined ? now + options.delayMs : undefined,
        retries: 0,
        maxRetries: options?.maxRetries ?? 3,
        timeoutMs: options?.timeoutMs,
        metadata: options?.metadata,
      };

      tasks.set(id, task);
      emit({ kind: "task:submitted", task });

      // Start a Temporal Workflow for this task
      const handle = await config.client.workflow.start(config.workflowType, {
        taskQueue: config.taskQueue,
        workflowId: id,
        args: [{ agentId, sessionId: id, stateRefs: { lastTurnId: undefined, turnsProcessed: 0 } }],
      });

      // Signal the workflow with the task input
      await config.client.workflow.signal(handle.workflowId, "message", {
        id: `task:${id}`,
        senderId: "scheduler",
        content: input.kind === "messages" ? input.messages : [],
        timestamp: now,
      });

      return id;
    },

    async cancel(id: TaskId): Promise<boolean> {
      const task = tasks.get(id);
      if (task === undefined) return false;

      try {
        await config.client.workflow.cancel(id);
        tasks.set(id, { ...task, status: "failed" });
        emit({ kind: "task:cancelled", taskId: id });
        return true;
      } catch {
        return false;
      }
    },

    async schedule(
      expression: string,
      agentId: AgentId,
      input: EngineInput,
      mode: "spawn" | "dispatch",
      options?: TaskOptions & { readonly timezone?: string | undefined },
    ): Promise<ScheduleId> {
      const id = toScheduleId(`sched:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`);

      const schedule: CronSchedule = {
        id,
        expression,
        agentId,
        input,
        mode,
        taskOptions: options,
        timezone: options?.timezone,
        paused: false,
      };

      schedules.set(id, schedule);

      await config.client.schedule.create(id, {
        spec: { cronExpressions: [expression] },
        action: {
          type: "startWorkflow",
          workflowType: config.workflowType,
          taskQueue: config.taskQueue,
          args: [
            { agentId, sessionId: id, stateRefs: { lastTurnId: undefined, turnsProcessed: 0 } },
          ],
        },
      });

      emit({ kind: "schedule:created", schedule });
      return id;
    },

    async unschedule(id: ScheduleId): Promise<boolean> {
      if (!schedules.has(id)) return false;

      try {
        await config.client.schedule.delete(id);
        schedules.delete(id);
        emit({ kind: "schedule:removed", scheduleId: id });
        return true;
      } catch {
        return false;
      }
    },

    async pause(id: ScheduleId): Promise<boolean> {
      const schedule = schedules.get(id);
      if (schedule === undefined) return false;

      try {
        await config.client.schedule.pause(id);
        schedules.set(id, { ...schedule, paused: true });
        emit({ kind: "schedule:paused", scheduleId: id });
        return true;
      } catch {
        return false;
      }
    },

    async resume(id: ScheduleId): Promise<boolean> {
      const schedule = schedules.get(id);
      if (schedule === undefined) return false;

      try {
        await config.client.schedule.unpause(id);
        schedules.set(id, { ...schedule, paused: false });
        emit({ kind: "schedule:resumed", scheduleId: id });
        return true;
      } catch {
        return false;
      }
    },

    query(filter: TaskFilter): readonly ScheduledTask[] {
      let result = [...tasks.values()];
      if (filter.status !== undefined) {
        result = result.filter((t) => t.status === filter.status);
      }
      if (filter.agentId !== undefined) {
        result = result.filter((t) => t.agentId === filter.agentId);
      }
      if (filter.priority !== undefined) {
        result = result.filter((t) => t.priority === filter.priority);
      }
      if (filter.limit !== undefined) {
        result = result.slice(0, filter.limit);
      }
      return result;
    },

    stats: computeStats,

    history(filter: TaskHistoryFilter): readonly TaskRunRecord[] {
      let result = [...history];
      if (filter.agentId !== undefined) {
        result = result.filter((r) => r.agentId === filter.agentId);
      }
      if (filter.status !== undefined) {
        result = result.filter((r) => r.status === filter.status);
      }
      if (filter.since !== undefined) {
        result = result.filter((r) => r.startedAt >= (filter.since ?? 0));
      }
      if (filter.limit !== undefined) {
        result = result.slice(0, filter.limit);
      }
      return result;
    },

    watch(listener: (event: SchedulerEvent) => void): () => void {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },

    async [Symbol.asyncDispose](): Promise<void> {
      eventListeners.clear();
      tasks.clear();
      schedules.clear();
    },
  };
}
