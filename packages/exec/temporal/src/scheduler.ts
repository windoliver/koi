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
  KoiError,
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

/** Terminal and in-progress states reported by Temporal workflow describe. */
export type TemporalWorkflowStatus =
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TERMINATED"
  | "CONTINUED_AS_NEW"
  | "TIMED_OUT";

export interface WorkflowExecutionStatus {
  readonly status: TemporalWorkflowStatus;
  /** Epoch ms when execution started on a worker. */
  readonly startTime?: number | undefined;
  /** Epoch ms when execution reached a terminal state. */
  readonly closeTime?: number | undefined;
  /** Failure message for FAILED/TIMED_OUT workflows. */
  readonly failure?: { readonly message: string } | undefined;
}

export interface TemporalClientLike {
  readonly workflow: {
    readonly start: (
      workflowType: string,
      options: Record<string, unknown>,
    ) => Promise<{ readonly workflowId: string }>;
    readonly cancel: (workflowId: string) => Promise<void>;
    /**
     * Fetch current execution status for a workflow by ID.
     * Optional — when absent, task state is process-local only with no
     * Temporal reconciliation.
     */
    readonly describe?: (workflowId: string) => Promise<WorkflowExecutionStatus>;
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

  // Reconciles a single task against Temporal describe result.
  // Terminal tasks are removed from `tasks`, added to `history`, and events fired.
  async function reconcileTask(id: TaskId, task: ScheduledTask): Promise<void> {
    const describeFn = config.client.workflow.describe;
    if (describeFn === undefined) return;
    let info: WorkflowExecutionStatus;
    try {
      info = await describeFn(id as string);
    } catch {
      return; // describe unavailable or network error — keep current state
    }

    switch (info.status) {
      case "RUNNING":
      case "CONTINUED_AS_NEW": {
        if (task.status !== "running") {
          const updated: ScheduledTask = {
            ...task,
            status: "running",
            ...(info.startTime !== undefined && { startedAt: info.startTime }),
          };
          tasks.set(id, updated);
          emit({ kind: "task:started", taskId: id });
        }
        break;
      }

      case "COMPLETED": {
        const startedAt = info.startTime ?? task.startedAt ?? task.createdAt;
        const completedAt = info.closeTime ?? Date.now();
        history.push({
          taskId: id,
          agentId: task.agentId,
          status: "completed",
          startedAt,
          completedAt,
          durationMs: completedAt - startedAt,
          retryAttempt: task.retries,
        });
        tasks.delete(id);
        emit({ kind: "task:completed", taskId: id, result: undefined });
        break;
      }

      case "FAILED":
      case "TIMED_OUT": {
        const startedAt = info.startTime ?? task.startedAt ?? task.createdAt;
        const completedAt = info.closeTime ?? Date.now();
        const errorMessage =
          info.failure?.message ??
          (info.status === "TIMED_OUT" ? "workflow timed out" : "workflow failed");
        const koiError: KoiError = {
          code: info.status === "TIMED_OUT" ? "TIMEOUT" : "INTERNAL",
          message: errorMessage,
          retryable: false,
        };
        history.push({
          taskId: id,
          agentId: task.agentId,
          status: "failed",
          startedAt,
          completedAt,
          durationMs: completedAt - startedAt,
          error: errorMessage,
          retryAttempt: task.retries,
        });
        tasks.delete(id);
        emit({ kind: "task:failed", taskId: id, error: koiError });
        break;
      }

      case "TERMINATED":
      case "CANCELLED": {
        // Operator-initiated termination — remove without surfacing as failure.
        tasks.delete(id);
        emit({ kind: "task:cancelled", taskId: id });
        break;
      }
    }
  }

  // Reconciles all locally-tracked pending/running tasks against Temporal.
  async function reconcileAll(): Promise<void> {
    if (config.client.workflow.describe === undefined) return;
    const active = [...tasks.entries()].filter(
      ([, t]) => t.status === "pending" || t.status === "running",
    );
    await Promise.all(active.map(([id, task]) => reconcileTask(id, task)));
  }

  return {
    async submit(agentId, input, mode, options): Promise<TaskId> {
      const rawId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const id = taskId(rawId);
      const task = buildTask(id, agentId, input, mode, options);

      const messages = mapEngineInputToMessages(input, rawId);
      // Register only after a confirmed start so a failed start leaves no
      // phantom entry in local tracking and callers can retry with a new ID.
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

      tasks.set(id, task);
      emit({ kind: "task:submitted", task });
      return id;
    },

    async cancel(id): Promise<boolean> {
      try {
        await config.client.workflow.cancel(id);
        if (tasks.has(id)) {
          // Remove from active tracking — cancellation is an operator action,
          // not an execution failure.
          tasks.delete(id);
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
          // sessionId is intentionally absent: each Temporal execution gets a
          // unique workflowId and should derive its sessionId from
          // workflowInfo().workflowId so independent firings never share state.
          args: [{ agentId, messages, mode }],
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

    async query(filter): Promise<readonly ScheduledTask[]> {
      await reconcileAll();
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
      // Reads from the local cache. Call query({}) first to reconcile against
      // Temporal when describe is available.
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

    history(filter): readonly TaskRunRecord[] {
      let results = [...history];
      if (filter.agentId !== undefined) {
        results = results.filter((r) => r.agentId === filter.agentId);
      }
      if (filter.status !== undefined) {
        results = results.filter((r) => r.status === filter.status);
      }
      if (filter.since !== undefined) {
        const since = filter.since;
        results = results.filter((r) => r.completedAt >= since);
      }
      if (filter.limit !== undefined) {
        results = results.slice(0, filter.limit);
      }
      return results;
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
