import type {
  AgentId,
  CronSchedule,
  EngineInput,
  KoiError,
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
import type { IncomingMessage, ScheduledSpawnArgs } from "./types.js";

function toTaskId(id: string): TaskId {
  return id as TaskId;
}

function toScheduleId(id: string): ScheduleId {
  return id as ScheduleId;
}

function mapEngineInputToMessages(input: EngineInput, taskId: string): readonly IncomingMessage[] {
  const now = Date.now();
  switch (input.kind) {
    case "text":
      return [
        {
          id: `${taskId}:0`,
          senderId: "scheduler",
          content: [{ kind: "text", text: input.text }],
          timestamp: now,
        },
      ];
    case "messages":
      return input.messages.map(
        (msg, i): IncomingMessage => ({
          id: `${taskId}:${i}`,
          senderId: msg.senderId,
          content: [...msg.content],
          timestamp: msg.timestamp,
          threadId: msg.threadId,
          metadata: msg.metadata as Record<string, unknown> | undefined,
          pinned: msg.pinned,
        }),
      );
    case "resume":
      return [
        {
          id: `${taskId}:resume`,
          senderId: "scheduler",
          content: [],
          timestamp: now,
          resumeState: input.state,
        },
      ];
  }
}

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
    readonly getResult?: ((workflowId: string) => Promise<unknown>) | undefined;
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
  readonly workflowType: string;
}

/**
 * Creates a Temporal-backed TaskScheduler.
 *
 * **In-memory limitation**: task/schedule state is stored in ephemeral Maps.
 * After a process restart, `cancel()`, `query()`, `history()`, `pause()`, and
 * `resume()` lose visibility into previously-created Temporal resources. For spawn
 * tasks, `cancel(taskId)` still attempts a remote cancel because the taskId equals
 * the workflowId at submission time. Dispatch-mode resources cannot be recovered
 * this way. For production reliability, back this with an external state store.
 */
export function createTemporalScheduler(config: TemporalSchedulerConfig): TaskScheduler {
  const tasks = new Map<string, ScheduledTask>();
  const schedules = new Map<string, CronSchedule>();
  const history: TaskRunRecord[] = [];
  const eventListeners = new Set<(event: SchedulerEvent) => void>();
  // Maps taskId → the actual Temporal workflowId used (spawn = task id, dispatch = agentId)
  const taskWorkflowIds = new Map<string, string>();

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
      if (mode === "dispatch" && options?.delayMs !== undefined) {
        throw new Error(
          "delayMs is not supported for dispatch mode — dispatch targets a running workflow and cannot defer signal delivery",
        );
      }

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

      const messages = mapEngineInputToMessages(input, id);

      // Only record locally after the remote call succeeds to keep state consistent.
      // For spawn: start a new workflow then signal it with each message.
      // For dispatch: signal an existing workflow identified by agentId — no new workflow.
      let targetWorkflowId: string;
      try {
        if (mode === "spawn") {
          const handle = await config.client.workflow.start(config.workflowType, {
            taskQueue: config.taskQueue,
            workflowId: id,
            args: [
              { agentId, sessionId: id, stateRefs: { lastTurnId: undefined, turnsProcessed: 0 } },
            ],
            ...(options?.delayMs !== undefined ? { startDelay: `${options.delayMs}ms` } : {}),
          });
          targetWorkflowId = handle.workflowId;
        } else {
          // dispatch: target the long-running workflow for this agent
          targetWorkflowId = String(agentId);
        }

        for (const msg of messages) {
          await config.client.workflow.signal(targetWorkflowId, "message", msg);
        }
      } catch (err: unknown) {
        // Compensate: if spawn started but signal failed, cancel the orphaned workflow
        if (mode === "spawn") {
          try {
            await config.client.workflow.cancel(id);
          } catch {
            // Best-effort — workflow may not have started yet
          }
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        const koiError: KoiError = {
          code: "EXTERNAL",
          message: errorMsg,
          retryable: false,
          context: { taskId: id, agentId },
        };
        const failedTask: ScheduledTask = { ...task, status: "failed" };
        tasks.set(id, failedTask);
        emit({ kind: "task:submitted", task: failedTask });
        history.push({
          taskId: id,
          agentId,
          status: "failed",
          startedAt: now,
          completedAt: Date.now(),
          durationMs: Date.now() - now,
          error: errorMsg,
          retryAttempt: 0,
        });
        emit({ kind: "task:failed", taskId: id, error: koiError });
        return id;
      }

      // Remote calls succeeded — record locally as running
      taskWorkflowIds.set(id, targetWorkflowId);
      tasks.set(id, task);
      emit({ kind: "task:submitted", task });
      const runningTask: ScheduledTask = { ...task, status: "running" };
      tasks.set(id, runningTask);

      if (config.client.workflow.getResult !== undefined && mode === "spawn") {
        const startedAt = now;
        void config.client.workflow.getResult(id).then(
          (result: unknown) => {
            const completedAt = Date.now();
            tasks.set(id, { ...runningTask, status: "completed" });
            history.push({
              taskId: id,
              agentId,
              status: "completed",
              startedAt,
              completedAt,
              durationMs: completedAt - startedAt,
              result,
              retryAttempt: 0,
            });
            emit({ kind: "task:completed", taskId: id, result });
          },
          (error: unknown) => {
            const completedAt = Date.now();
            tasks.set(id, { ...runningTask, status: "failed" });
            const koiError: KoiError = {
              code: "EXTERNAL",
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
              context: { taskId: id, agentId },
            };
            history.push({
              taskId: id,
              agentId,
              status: "failed",
              startedAt,
              completedAt,
              durationMs: completedAt - startedAt,
              error: koiError.message,
              retryAttempt: 0,
            });
            emit({ kind: "task:failed", taskId: id, error: koiError });
          },
        );
      }

      return id;
    },

    async cancel(id: TaskId): Promise<boolean> {
      const task = tasks.get(id);
      // Attempt remote cancel even without local state: for spawn tasks, taskId === workflowId
      // so post-restart cancel requests can still reach the running workflow.
      const targetId = taskWorkflowIds.get(id) ?? id;
      try {
        await config.client.workflow.cancel(targetId);
        if (task !== undefined) {
          tasks.set(id, { ...task, status: "failed" });
        }
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

      const initialMessages = mapEngineInputToMessages(input, id);

      // spawn: start a fresh workflow on each cron firing.
      //   ScheduledSpawnArgs intentionally omits sessionId — each Temporal execution
      //   uses its own execution ID as the session namespace (no cross-run state collision).
      // dispatch: send a signal to the long-running agent workflow on each firing.
      //   A schedule fires exactly one action per interval, so only a single signal can
      //   be delivered. Multi-message inputs (>1 IncomingMessage) are rejected at
      //   schedule creation time to avoid silent message loss.
      let scheduleAction: Record<string, unknown>;
      if (mode === "spawn") {
        const spawnArgs: ScheduledSpawnArgs = {
          agentId,
          stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
          initialMessages,
        };
        scheduleAction = {
          type: "startWorkflow",
          workflowType: config.workflowType,
          taskQueue: config.taskQueue,
          args: [spawnArgs],
        };
      } else {
        if (initialMessages.length !== 1) {
          throw new Error(
            `Scheduled dispatch supports exactly one message per firing but got ${initialMessages.length}. ` +
              "Use a single-message EngineInput or submit() for multi-message delivery.",
          );
        }
        scheduleAction = {
          type: "sendSignal",
          workflowId: String(agentId),
          signalName: "message",
          // One positional arg matching direct-dispatch signal shape (signal(wfId, "message", msg))
          args: [initialMessages[0]],
        };
      }

      // Only insert locally after the remote create succeeds — no phantom schedule on failure.
      await config.client.schedule.create(id, {
        spec: {
          cronExpressions: [expression],
          ...(options?.timezone !== undefined ? { timezone: options.timezone } : {}),
        },
        action: scheduleAction,
      });

      schedules.set(id, schedule);
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
      taskWorkflowIds.clear();
      schedules.clear();
    },
  };
}
