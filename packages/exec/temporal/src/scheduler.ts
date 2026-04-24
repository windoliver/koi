/**
 * Temporal-backed TaskScheduler — implements L0 TaskScheduler contract.
 *
 * Bridges Koi task/cron definitions to Temporal Workflows and Schedules.
 * All Temporal SDK types are hidden behind structural interfaces.
 */

import type {
  AgentId,
  ContentBlock,
  CronSchedule,
  EngineInput,
  ScheduledTask,
  ScheduleId,
  SchedulerEvent,
  SchedulerStats,
  TaskId,
  TaskOptions,
  TaskRunRecord,
  TaskScheduler,
} from "@koi/core";
import { scheduleId, taskId } from "@koi/core";

// ---------------------------------------------------------------------------
// Structural types (no @temporalio/* imports)
// ---------------------------------------------------------------------------

export interface TemporalClientLike {
  readonly workflow: {
    readonly start: (
      workflowType: string,
      options: Record<string, unknown>,
    ) => Promise<{ readonly workflowId: string }>;
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
  readonly client: TemporalClientLike;
  readonly taskQueue: string;
  readonly workflowType?: string | undefined;
}

// ---------------------------------------------------------------------------
// Internal message format (workflow input)
// ---------------------------------------------------------------------------

interface WorkflowMessage {
  readonly id: string;
  readonly senderId: string;
  readonly content: readonly ContentBlock[];
  readonly timestamp: number;
}

function mapEngineInputToMessages(input: EngineInput, baseId: string): readonly WorkflowMessage[] {
  const now = Date.now();
  switch (input.kind) {
    case "text":
      return [
        {
          id: `${baseId}:0`,
          senderId: "scheduler",
          content: [{ kind: "text", text: input.text }],
          timestamp: now,
        },
      ];
    case "messages":
      return input.messages.map(
        (msg, i): WorkflowMessage => ({
          id: `${baseId}:${i}`,
          senderId: msg.senderId,
          content: [...msg.content],
          timestamp: msg.timestamp,
        }),
      );
    case "resume":
      return [
        {
          id: `${baseId}:resume`,
          senderId: "scheduler",
          content: [],
          timestamp: now,
          // Carry opaque resume state through to the workflow so it can restore checkpointed context
          ...(input.state !== undefined && { resumeState: input.state }),
        },
      ];
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTemporalScheduler(config: TemporalSchedulerConfig): TaskScheduler {
  const workflowType = config.workflowType ?? "agentWorkflow";

  // In-memory registries track submitted tasks within this process lifetime only.
  // Temporal is the source of truth for execution state; terminal-state
  // reconciliation (completion, dead-letter recovery, cross-process restart)
  // requires a Temporal event listener or periodic describe() poll wired by
  // the host. query()/stats() therefore reflect what THIS process submitted;
  // history() is intentionally empty until reconciliation is wired.
  const tasks = new Map<TaskId, ScheduledTask>();
  const schedules = new Map<ScheduleId, CronSchedule>();
  const history: TaskRunRecord[] = [];
  const listeners = new Set<(event: SchedulerEvent) => void>();

  function emit(event: SchedulerEvent): void {
    for (const listener of listeners) listener(event);
  }

  function buildTask(
    id: TaskId,
    agentId: AgentId,
    input: EngineInput,
    mode: "spawn" | "dispatch",
    options?: TaskOptions,
  ): ScheduledTask {
    return {
      id,
      agentId,
      input,
      mode,
      priority: options?.priority ?? 5,
      status: "pending",
      createdAt: Date.now(),
      scheduledAt: options?.delayMs !== undefined ? Date.now() + options.delayMs : undefined,
      retries: 0,
      maxRetries: options?.maxRetries ?? 3,
      timeoutMs: options?.timeoutMs,
      metadata: options?.metadata,
    };
  }

  return {
    async submit(agentId, input, mode, options): Promise<TaskId> {
      const rawId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const id = taskId(rawId);
      const task = buildTask(id, agentId, input, mode, options);
      tasks.set(id, task);

      const messages = mapEngineInputToMessages(input, rawId);
      await config.client.workflow.start(workflowType, {
        taskQueue: config.taskQueue,
        workflowId: rawId,
        args: [{ agentId, sessionId: rawId, messages, mode }],
        ...(options?.delayMs !== undefined && { startDelay: options.delayMs }),
        ...(options?.timeoutMs !== undefined && { workflowExecutionTimeout: options.timeoutMs }),
        ...(options?.maxRetries !== undefined && {
          retryPolicy: { maximumAttempts: options.maxRetries },
        }),
      });

      const running = { ...task, status: "running" as const, startedAt: Date.now() };
      tasks.set(id, running);
      emit({ kind: "task:submitted", task: running });
      return id;
    },

    async cancel(id): Promise<boolean> {
      try {
        await config.client.workflow.cancel(id);
        const task = tasks.get(id);
        if (task !== undefined) {
          tasks.set(id, { ...task, status: "failed", completedAt: Date.now() });
          emit({ kind: "task:cancelled", taskId: id });
        }
        return true;
      } catch (_e: unknown) {
        return false;
      }
    },

    async schedule(expression, agentId, input, mode, options): Promise<ScheduleId> {
      const rawId = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const id = scheduleId(rawId);
      const messages = mapEngineInputToMessages(input, rawId);

      await config.client.schedule.create(rawId, {
        spec: { cronExpressions: [expression], timezone: options?.timezone },
        action: {
          type: "startWorkflow",
          workflowType,
          taskQueue: config.taskQueue,
          args: [{ agentId, sessionId: rawId, messages, mode }],
          ...(options?.timeoutMs !== undefined && {
            workflowExecutionTimeout: options.timeoutMs,
          }),
          ...(options?.maxRetries !== undefined && {
            retryPolicy: { maximumAttempts: options.maxRetries },
          }),
        },
        memo: { agentId, mode, metadata: options?.metadata },
      });

      const cronSchedule: CronSchedule = {
        id,
        expression,
        agentId,
        input,
        mode,
        taskOptions: options,
        timezone: options?.timezone,
        paused: false,
      };
      schedules.set(id, cronSchedule);
      emit({ kind: "schedule:created", schedule: cronSchedule });
      return id;
    },

    async unschedule(id): Promise<boolean> {
      try {
        await config.client.schedule.delete(id);
        schedules.delete(id);
        emit({ kind: "schedule:removed", scheduleId: id });
        return true;
      } catch (_e: unknown) {
        return false;
      }
    },

    async pause(id): Promise<boolean> {
      try {
        await config.client.schedule.pause(id);
        const existing = schedules.get(id);
        if (existing !== undefined) {
          schedules.set(id, { ...existing, paused: true });
          emit({ kind: "schedule:paused", scheduleId: id });
        }
        return true;
      } catch (_e: unknown) {
        return false;
      }
    },

    async resume(id): Promise<boolean> {
      try {
        await config.client.schedule.unpause(id);
        const existing = schedules.get(id);
        if (existing !== undefined) {
          schedules.set(id, { ...existing, paused: false });
          emit({ kind: "schedule:resumed", scheduleId: id });
        }
        return true;
      } catch (_e: unknown) {
        return false;
      }
    },

    query(filter): readonly ScheduledTask[] {
      let results = [...tasks.values()];
      if (filter.agentId !== undefined) {
        results = results.filter((t) => t.agentId === filter.agentId);
      }
      if (filter.status !== undefined) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        results = results.filter((t) => statuses.includes(t.status));
      }
      return results;
    },

    stats(): SchedulerStats {
      const all = [...tasks.values()];
      const allSchedules = [...schedules.values()];
      return {
        pending: all.filter((t) => t.status === "pending").length,
        running: all.filter((t) => t.status === "running").length,
        completed: all.filter((t) => t.status === "completed").length,
        failed: all.filter((t) => t.status === "failed").length,
        deadLettered: all.filter((t) => t.status === "dead_letter").length,
        activeSchedules: allSchedules.filter((s) => !s.paused).length,
        pausedSchedules: allSchedules.filter((s) => s.paused).length,
      };
    },

    history(_filter): readonly TaskRunRecord[] {
      return [...history];
    },

    watch(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async [Symbol.asyncDispose](): Promise<void> {
      listeners.clear();
      tasks.clear();
      schedules.clear();
    },
  };
}
