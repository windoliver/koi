import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type {
  AgentId,
  CronSchedule,
  EngineInput,
  KoiError,
  ScheduledTask,
  ScheduledTaskStatus,
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
import type { IncomingMessage, ScheduledInputPayload, ScheduledSpawnArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Durable state persistence (used when config.dbPath is set)
// ---------------------------------------------------------------------------

interface PersistedTask {
  readonly id: string;
  readonly agentId: string;
  readonly mode: "spawn" | "dispatch";
  readonly input: ScheduledInputPayload;
  readonly priority: number;
  readonly status: string;
  readonly createdAt: number;
  readonly scheduledAt: number | undefined;
  readonly startedAt: number | undefined;
  readonly completedAt: number | undefined;
  readonly retries: number;
  readonly maxRetries: number;
  readonly timeoutMs: number | undefined;
  readonly lastError: unknown;
  readonly metadata: Record<string, unknown> | undefined;
}

interface PersistedSchedule {
  readonly id: string;
  readonly expression: string;
  readonly agentId: string;
  readonly input: ScheduledInputPayload;
  readonly mode: "spawn" | "dispatch";
  readonly timezone: string | undefined;
  readonly paused: boolean;
}

interface PersistedState {
  readonly tasks: readonly [string, PersistedTask][];
  readonly taskWorkflowIds: readonly [string, string][];
  readonly cancelledTaskIds: readonly string[];
  readonly schedules: readonly [string, PersistedSchedule][];
  readonly history: readonly TaskRunRecord[];
}

function loadStateSync(dbPath: string): PersistedState | undefined {
  try {
    return JSON.parse(readFileSync(dbPath, "utf8")) as PersistedState;
  } catch {
    return undefined;
  }
}

// Strip non-serializable values from workflow results (unknown type) so a
// single unserializable result does not disable the entire persistence layer.
function persistenceReplacer(_key: string, value: unknown): unknown {
  switch (typeof value) {
    case "function":
    case "symbol":
    case "bigint":
      return undefined;
    default:
      return value;
  }
}

// Atomic write: write to a temp file then rename, so a crash mid-write cannot
// corrupt or erase the last good snapshot.
function saveStateSync(dbPath: string, state: PersistedState): void {
  const tmp = `${dbPath}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, persistenceReplacer));
    renameSync(tmp, dbPath);
  } catch (err: unknown) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup of orphaned temp file
    }
    throw err;
  }
}

function reconstructTask(v: PersistedTask): ScheduledTask {
  return {
    id: v.id as TaskId,
    agentId: v.agentId as AgentId,
    // callHandlers and signal are process-local and cannot survive restart.
    input: v.input as unknown as EngineInput,
    mode: v.mode,
    priority: v.priority,
    status: v.status as ScheduledTaskStatus,
    createdAt: v.createdAt,
    scheduledAt: v.scheduledAt,
    startedAt: v.startedAt,
    completedAt: v.completedAt,
    retries: v.retries,
    maxRetries: v.maxRetries,
    timeoutMs: v.timeoutMs,
    lastError: v.lastError as KoiError | undefined,
    metadata: v.metadata,
  };
}

function reconstructSchedule(v: PersistedSchedule): CronSchedule {
  return {
    id: v.id as ScheduleId,
    expression: v.expression,
    agentId: v.agentId as AgentId,
    input: v.input as unknown as EngineInput,
    mode: v.mode,
    timezone: v.timezone,
    paused: v.paused,
  };
}

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

function assertJsonSafeValue(value: unknown, path: string): void {
  switch (typeof value) {
    case "function":
    case "symbol":
    case "bigint":
      throw new Error(
        `schedule() payload contains a non-JSON-serializable ${typeof value} at "${path}". Remove it before scheduling.`,
      );
    case "object":
      if (value === null) return;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          assertJsonSafeValue(value[i], `${path}[${i}]`);
        }
      } else {
        // Reject non-plain objects: Date, Map, Set, Error, typed arrays, class instances
        // all stringify lossily (empty object, string coercion, etc.) without throwing.
        const proto = Object.getPrototypeOf(value) as object | null;
        if (proto !== Object.prototype && proto !== null) {
          const ctorName =
            (value as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
          throw new Error(
            `schedule() payload contains a non-plain object (${ctorName}) at "${path}". ` +
              "Only plain JSON values are allowed — remove Dates, Maps, Sets, class instances, and typed arrays.",
          );
        }
        for (const key of Object.keys(value)) {
          assertJsonSafeValue((value as Record<string, unknown>)[key], `${path}.${key}`);
        }
      }
      break;
    default:
      break;
  }
}

// Verify the payload is JSON-serializable before passing it to Temporal.
// Two-pass: JSON.stringify catches circular refs (throws); recursive walk catches
// functions, Symbols, and BigInts that JSON.stringify silently drops without throwing.
function assertJsonSerializable(value: unknown): void {
  try {
    JSON.stringify(value);
  } catch (err: unknown) {
    throw new Error(
      `schedule() payload contains a non-JSON-serializable circular reference — remove it before scheduling. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  assertJsonSafeValue(value, "payload");
}

// Strip non-serializable EngineInputBase fields (callHandlers, AbortSignal) before
// embedding the input into a Temporal schedule definition.
function mapEngineInputToScheduledPayload(input: EngineInput): ScheduledInputPayload {
  switch (input.kind) {
    case "text":
      return { kind: "text", text: input.text };
    case "messages":
      return { kind: "messages", messages: input.messages };
    case "resume":
      return { kind: "resume", state: input.state };
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
    readonly getResult: (workflowId: string) => Promise<unknown>;
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
  /**
   * Path to a JSON file for durable state persistence. When provided, task/schedule
   * state is written on each mutation and restored on startup, preserving management
   * API visibility across process restarts. When absent, state is ephemeral.
   */
  readonly dbPath?: string | undefined;
}

export function createTemporalScheduler(config: TemporalSchedulerConfig): TaskScheduler {
  const tasks = new Map<string, ScheduledTask>();
  const schedules = new Map<string, CronSchedule>();
  const history: TaskRunRecord[] = [];
  const eventListeners = new Set<(event: SchedulerEvent) => void>();
  // Tracks cancelled spawn tasks so background getResult handlers no-op after cancellation wins.
  const cancelledTaskIds = new Set<string>();
  // Maps taskId → the actual Temporal workflowId used (spawn = task id, dispatch = agentId)
  const taskWorkflowIds = new Map<string, string>();

  // Restore state from disk if dbPath is configured and a prior snapshot exists.
  if (config.dbPath !== undefined) {
    const saved = loadStateSync(config.dbPath);
    if (saved !== undefined) {
      for (const [k, v] of saved.tasks) tasks.set(k, reconstructTask(v));
      for (const [k, v] of saved.taskWorkflowIds) taskWorkflowIds.set(k, v);
      for (const id of saved.cancelledTaskIds) cancelledTaskIds.add(id);
      for (const [k, v] of saved.schedules) schedules.set(k, reconstructSchedule(v));
      for (const record of saved.history) history.push(record);
    }
  }

  function persist(): void {
    if (config.dbPath === undefined) return;
    try {
      saveStateSync(config.dbPath, {
        tasks: [...tasks.entries()].map(([k, v]) => [
          k,
          {
            id: v.id,
            agentId: v.agentId,
            mode: v.mode,
            input: mapEngineInputToScheduledPayload(v.input),
            priority: v.priority,
            status: v.status,
            createdAt: v.createdAt,
            scheduledAt: v.scheduledAt,
            startedAt: v.startedAt,
            completedAt: v.completedAt,
            retries: v.retries,
            maxRetries: v.maxRetries,
            timeoutMs: v.timeoutMs,
            lastError: v.lastError,
            metadata: v.metadata as Record<string, unknown> | undefined,
          } satisfies PersistedTask,
        ]),
        taskWorkflowIds: [...taskWorkflowIds.entries()],
        cancelledTaskIds: [...cancelledTaskIds],
        schedules: [...schedules.entries()].map(([k, v]) => [
          k,
          {
            id: v.id,
            expression: v.expression,
            agentId: v.agentId,
            mode: v.mode,
            input: mapEngineInputToScheduledPayload(v.input),
            timezone: v.timezone,
            paused: v.paused,
          } satisfies PersistedSchedule,
        ]),
        history,
      });
    } catch (err: unknown) {
      // Hard error: log so operators are alerted — silently swallowing would hide data loss
      console.error("[temporal-scheduler] persistence write failed:", err);
    }
  }

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

  // Reattach getResult watchers for spawn tasks that were running at the time of
  // a previous shutdown, so completion/failure events are recorded after restart.
  for (const [taskId, task] of tasks) {
    if (task.mode !== "spawn" || task.status !== "running") continue;
    const workflowId = taskWorkflowIds.get(taskId) ?? taskId;
    const startedAt = task.startedAt ?? task.createdAt;
    const agentId = task.agentId;
    void config.client.workflow.getResult(workflowId).then(
      (result: unknown) => {
        if (cancelledTaskIds.has(taskId)) return;
        const completedAt = Date.now();
        tasks.set(taskId, { ...task, status: "completed" });
        history.push({
          taskId: taskId as TaskId,
          agentId,
          status: "completed",
          startedAt,
          completedAt,
          durationMs: completedAt - startedAt,
          result,
          retryAttempt: 0,
        });
        emit({ kind: "task:completed", taskId: taskId as TaskId, result });
        persist();
      },
      (error: unknown) => {
        if (cancelledTaskIds.has(taskId)) return;
        const completedAt = Date.now();
        const koiError: KoiError = {
          code: "EXTERNAL",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          context: { taskId, agentId },
        };
        tasks.set(taskId, { ...task, status: "failed" });
        history.push({
          taskId: taskId as TaskId,
          agentId,
          status: "failed",
          startedAt,
          completedAt,
          durationMs: completedAt - startedAt,
          error: koiError.message,
          retryAttempt: 0,
        });
        emit({ kind: "task:failed", taskId: taskId as TaskId, error: koiError });
        persist();
      },
    );
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
      if (options?.timeoutMs !== undefined || options?.maxRetries !== undefined) {
        throw new Error(
          "submit() does not enforce timeoutMs or maxRetries. Remove these options or implement them inside the target workflow.",
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
      // Initialize to id so the rollback cancel uses the requested workflowId even if start() throws
      // before handle.workflowId is assigned.
      let targetWorkflowId: string = id;
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
            await config.client.workflow.cancel(targetWorkflowId);
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
        persist();
        throw new Error(`submit() could not reach Temporal for agent ${agentId}: ${errorMsg}`, {
          cause: err,
        });
      }

      // Remote calls succeeded — emit submitted then handle mode-specific lifecycle.
      taskWorkflowIds.set(id, targetWorkflowId);
      tasks.set(id, task);
      emit({ kind: "task:submitted", task });

      if (mode === "dispatch") {
        // Signal delivery is the entire task — mark completed immediately so
        // query()/stats() don't accumulate stale running dispatch tasks.
        const completedAt = Date.now();
        tasks.set(id, { ...task, status: "completed" });
        history.push({
          taskId: id,
          agentId,
          status: "completed",
          startedAt: now,
          completedAt,
          durationMs: completedAt - now,
          retryAttempt: 0,
        });
        emit({ kind: "task:completed", taskId: id, result: undefined });
        persist();
      } else {
        // Spawn: track actual workflow completion via getResult.
        // Gate on cancelledTaskIds so a raced cancel wins and prevents double terminal events.
        const runningTask: ScheduledTask = { ...task, status: "running" };
        tasks.set(id, runningTask);
        persist();
        const startedAt = now;
        void config.client.workflow.getResult(targetWorkflowId).then(
          (result: unknown) => {
            if (cancelledTaskIds.has(id)) return;
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
            persist();
          },
          (error: unknown) => {
            if (cancelledTaskIds.has(id)) return;
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
            persist();
          },
        );
      }

      return id;
    },

    async cancel(id: TaskId): Promise<boolean> {
      const task = tasks.get(id);
      if (task === undefined) return false;
      // Dispatch signals are delivered immediately; there is no workflow-level cancel
      // that targets only this task. Cancelling the agent workflow ID would destroy
      // all in-flight work for that agent, not just this task.
      if (task.mode === "dispatch") return false;
      const targetId = taskWorkflowIds.get(id) ?? id;
      try {
        // Mark cancelled before the remote call so any concurrent getResult
        // handler that fires during or after sees the cancelled gate first.
        cancelledTaskIds.add(id);
        await config.client.workflow.cancel(targetId);
        tasks.set(id, { ...task, status: "failed" });
        emit({ kind: "task:cancelled", taskId: id });
        persist();
        return true;
      } catch {
        cancelledTaskIds.delete(id);
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
      // timeoutMs and maxRetries cannot be plumbed into Temporal schedule policies —
      // accepting them silently would give callers a false guarantee of enforcement.
      if (
        options?.timeoutMs !== undefined ||
        options?.maxRetries !== undefined ||
        options?.delayMs !== undefined
      ) {
        throw new Error(
          "schedule() does not enforce timeoutMs, maxRetries, or delayMs via Temporal schedule policies. " +
            "Remove these options or implement them inside the target workflow.",
        );
      }

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

      // Strip non-serializable EngineInput fields (callHandlers, AbortSignal) then
      // deep-validate JSON safety before passing to Temporal's durable schedule store.
      const scheduledPayload = mapEngineInputToScheduledPayload(input);
      assertJsonSerializable(scheduledPayload);

      // spawn: startWorkflow on each cron firing. ScheduledSpawnArgs carries the
      //   serialized payload; the workflow generates fresh IncomingMessage IDs and
      //   timestamps at each execution to prevent duplicate idempotency keys.
      // dispatch: "scheduled-input" signal with serialized payload so the workflow
      //   signal handler creates a fresh IncomingMessage envelope per firing.
      //   Distinct signal name prevents conflating one-shot direct signals ("message")
      //   with recurring schedule-fired inputs.
      let scheduleAction: Record<string, unknown>;
      if (mode === "spawn") {
        const spawnArgs: ScheduledSpawnArgs = {
          agentId,
          stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
          input: scheduledPayload,
        };
        scheduleAction = {
          type: "startWorkflow",
          workflowType: config.workflowType,
          taskQueue: config.taskQueue,
          // Explicit workflowId so Temporal can apply overlap/reuse policies deterministically.
          // The schedule ID is the stable base; Temporal's overlap policy governs concurrent firings.
          workflowId: id,
          args: [spawnArgs],
        };
      } else {
        scheduleAction = {
          type: "sendSignal",
          workflowId: String(agentId),
          signalName: "scheduled-input",
          args: [scheduledPayload],
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
      persist();
      return id;
    },

    async unschedule(id: ScheduleId): Promise<boolean> {
      if (!schedules.has(id)) return false;
      try {
        await config.client.schedule.delete(id);
        schedules.delete(id);
        emit({ kind: "schedule:removed", scheduleId: id });
        persist();
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
        persist();
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
        persist();
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
      cancelledTaskIds.clear();
      schedules.clear();
    },
  };
}
