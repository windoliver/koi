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
import { agentId, scheduleId, taskId } from "@koi/core";

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
  /** Memo fields written at workflow start — used for ownership verification. */
  readonly memo?: Readonly<Record<string, unknown>> | undefined;
}

/** Subset of schedule state fetched for ownership verification on idempotent replay. */
export interface ScheduleGetInfo {
  readonly memo?: Readonly<Record<string, unknown>> | undefined;
}

/** Single workflow entry returned by list — used for bootstrap state reconstruction. */
export interface WorkflowListEntry {
  readonly workflowId: string;
  readonly status: WorkflowExecutionStatus;
}

/** Single schedule entry returned by list — used for bootstrap state reconstruction. */
export interface ScheduleListEntry {
  readonly scheduleId: string;
  readonly info: ScheduleGetInfo;
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
    /**
     * List workflows matching the given filter — used by bootstrap() to rebuild
     * in-memory task state after a process restart.
     */
    readonly list?: (filter: {
      readonly workflowType: string;
      readonly taskQueue: string;
    }) => Promise<readonly WorkflowListEntry[]>;
  };
  readonly schedule: {
    readonly create: (scheduleId: string, options: Record<string, unknown>) => Promise<unknown>;
    readonly delete: (scheduleId: string) => Promise<void>;
    readonly pause: (scheduleId: string, note?: string) => Promise<void>;
    readonly unpause: (scheduleId: string, note?: string) => Promise<void>;
    /**
     * Fetch existing schedule metadata for ownership verification on idempotent replay.
     * Optional — when absent, stable-ID replays fail closed to prevent silent collisions.
     */
    readonly get?: (scheduleId: string) => Promise<ScheduleGetInfo>;
    /** List all schedules — used by bootstrap() to rebuild in-memory schedule state. */
    readonly list?: () => Promise<readonly ScheduleListEntry[]>;
  };
}

export interface TemporalSchedulerConfig {
  readonly client: TemporalClientLike;
  readonly taskQueue: string;
  readonly workflowType?: string | undefined;
}

/** Default retry budget forwarded to Temporal when the caller omits maxRetries. */
export const DEFAULT_MAX_RETRIES = 3;

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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the error indicates a workflow or schedule already exists in
 * Temporal. Used to implement idempotent retries for stable IDs.
 *
 * Structural check — no @temporalio/client import needed.
 */
function isAlreadyExistsError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    r.name === "WorkflowExecutionAlreadyStartedError" ||
    r.name === "AlreadyExistsError" ||
    (typeof r.message === "string" &&
      (r.message.includes("already exists") || r.message.includes("already started")))
  );
}

/**
 * Strips non-serializable runtime fields (callHandlers, correlationIds,
 * maxStopRetries) from EngineInput before passing it to Temporal.
 * Temporal serializes args to JSON; functions cause a runtime error.
 */
function serializeEngineInput(input: EngineInput): Record<string, unknown> {
  switch (input.kind) {
    case "text":
      return { kind: input.kind, text: input.text };
    case "messages":
      return { kind: input.kind, messages: [...input.messages] };
    case "resume":
      return { kind: input.kind, state: input.state };
  }
}

/**
 * Reconstructs an EngineInput from the stored inputFingerprint memo field.
 * Falls back to an empty text input when the stored value cannot be parsed.
 */
function parseStoredEngineInput(fingerprint: string): EngineInput {
  const v: unknown = JSON.parse(fingerprint);
  if (typeof v === "object" && v !== null) {
    const r = v as Record<string, unknown>; // safe: just narrowed to object
    if (r.kind === "text" && typeof r.text === "string") return { kind: "text", text: r.text };
    if (r.kind === "resume") {
      // Reconstruct EngineState from stored memo — engineId is required, data is opaque.
      const s =
        typeof r.state === "object" && r.state !== null ? (r.state as Record<string, unknown>) : {};
      const engineId = typeof s.engineId === "string" ? s.engineId : "";
      return { kind: "resume", state: { engineId, data: s.data } };
    }
    if (r.kind === "messages" && Array.isArray(r.messages))
      // Messages are opaque blobs from storage — cast through unknown for type safety.
      return { kind: "messages", messages: r.messages as unknown as readonly never[] };
  }
  return { kind: "text", text: "" };
}

/**
 * Verifies that an existing workflow's memo matches the full request fingerprint.
 * Absent memo or any mismatched field is treated as a collision — fail closed.
 * Returns the execution status so the caller can handle terminal states
 * (e.g., avoid re-registering a completed workflow as a new pending task).
 */
async function verifyWorkflowOwnership(
  describeFn: (id: string) => Promise<WorkflowExecutionStatus>,
  workflowId: string,
  claim: {
    readonly agentId: AgentId;
    readonly mode: "spawn" | "dispatch";
    readonly workflowType: string;
    readonly taskQueue: string;
    readonly inputFingerprint: string;
    readonly timeoutMs: number | undefined;
    readonly maxRetries: number | undefined;
  },
): Promise<WorkflowExecutionStatus> {
  let info: WorkflowExecutionStatus;
  try {
    info = await describeFn(workflowId);
  } catch {
    throw new Error(`Cannot verify ownership of workflow "${workflowId}": describe call failed`);
  }
  const m = info.memo;
  if (
    m === undefined ||
    m.agentId !== claim.agentId ||
    m.mode !== claim.mode ||
    m.workflowType !== claim.workflowType ||
    m.taskQueue !== claim.taskQueue ||
    m.inputFingerprint !== claim.inputFingerprint ||
    m.timeoutMs !== claim.timeoutMs ||
    m.maxRetries !== claim.maxRetries
  ) {
    throw new Error(
      `Workflow ID collision: "${workflowId}" already exists with different configuration`,
    );
  }
  return info;
}

/**
 * Verifies that an existing schedule's memo matches the full request fingerprint.
 * Absent memo or any mismatched field is treated as a collision — fail closed.
 */
async function verifyScheduleOwnership(
  getFn: (id: string) => Promise<ScheduleGetInfo>,
  rawId: string,
  claim: {
    readonly agentId: AgentId;
    readonly mode: "spawn" | "dispatch";
    readonly workflowType: string;
    readonly taskQueue: string;
    readonly expression: string;
    readonly timezone: string | undefined;
    readonly inputFingerprint: string;
    readonly timeoutMs: number | undefined;
    readonly maxRetries: number | undefined;
  },
): Promise<void> {
  let info: ScheduleGetInfo;
  try {
    info = await getFn(rawId);
  } catch {
    throw new Error(`Cannot verify ownership of schedule "${rawId}": get call failed`);
  }
  const m = info.memo;
  if (
    m === undefined ||
    m.agentId !== claim.agentId ||
    m.mode !== claim.mode ||
    m.workflowType !== claim.workflowType ||
    m.taskQueue !== claim.taskQueue ||
    m.expression !== claim.expression ||
    m.timezone !== claim.timezone ||
    m.inputFingerprint !== claim.inputFingerprint ||
    m.timeoutMs !== claim.timeoutMs ||
    m.maxRetries !== claim.maxRetries
  ) {
    throw new Error(
      `Schedule ID collision: "${rawId}" already exists with different configuration`,
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTemporalScheduler(
  config: TemporalSchedulerConfig,
): TaskScheduler & { readonly bootstrap: () => Promise<void> } {
  const workflowType = config.workflowType ?? "agentWorkflow";

  const tasks = new Map<TaskId, ScheduledTask>();
  const schedules = new Map<ScheduleId, CronSchedule>();
  const history: TaskRunRecord[] = [];
  const listeners = new Set<(event: SchedulerEvent) => void>();
  // Tracks tasks with an in-flight describe call to prevent duplicate reconciliation.
  const reconciling = new Set<TaskId>();

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
      maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
      timeoutMs: options?.timeoutMs,
      metadata: options?.metadata,
    };
  }

  // Reconciles a single task against Temporal describe result.
  // Guards against concurrent reconciliation of the same task ID.
  async function reconcileTask(id: TaskId, _task: ScheduledTask): Promise<void> {
    const describeFn = config.client.workflow.describe;
    if (describeFn === undefined) return;
    if (reconciling.has(id)) return;
    reconciling.add(id);
    try {
      let info: WorkflowExecutionStatus;
      try {
        info = await describeFn(id as string);
      } catch {
        return; // describe unavailable or network error — keep current state
      }

      // Re-check after async gap: a concurrent cancel() may have removed the task.
      const current = tasks.get(id);
      if (current === undefined) return;

      switch (info.status) {
        case "RUNNING":
        case "CONTINUED_AS_NEW": {
          if (current.status !== "running") {
            const updated: ScheduledTask = {
              ...current,
              status: "running",
              ...(info.startTime !== undefined && { startedAt: info.startTime }),
            };
            tasks.set(id, updated);
            emit({ kind: "task:started", taskId: id });
          }
          break;
        }

        case "COMPLETED": {
          const startedAt = info.startTime ?? current.startedAt ?? current.createdAt;
          const completedAt = info.closeTime ?? Date.now();
          history.push({
            taskId: id,
            agentId: current.agentId,
            status: "completed",
            startedAt,
            completedAt,
            durationMs: completedAt - startedAt,
            retryAttempt: current.retries,
          });
          tasks.delete(id);
          emit({ kind: "task:completed", taskId: id, result: undefined });
          break;
        }

        case "FAILED":
        case "TIMED_OUT": {
          const startedAt = info.startTime ?? current.startedAt ?? current.createdAt;
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
            agentId: current.agentId,
            status: "failed",
            startedAt,
            completedAt,
            durationMs: completedAt - startedAt,
            error: errorMessage,
            retryAttempt: current.retries,
          });
          tasks.delete(id);
          emit({ kind: "task:failed", taskId: id, error: koiError });
          break;
        }

        case "TERMINATED":
        case "CANCELLED": {
          const startedAt = info.startTime ?? current.startedAt ?? current.createdAt;
          const completedAt = info.closeTime ?? Date.now();
          history.push({
            taskId: id,
            agentId: current.agentId,
            status: "failed",
            startedAt,
            completedAt,
            durationMs: completedAt - startedAt,
            error: info.status === "TERMINATED" ? "workflow terminated" : "workflow cancelled",
            retryAttempt: current.retries,
          });
          tasks.delete(id);
          emit({ kind: "task:cancelled", taskId: id });
          break;
        }
      }
    } finally {
      reconciling.delete(id);
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
      // Callers may supply metadata.workflowId for a stable, retry-safe ID.
      // Without it, a random ID is minted (no idempotency guarantee on retries).
      const idempotencyKey =
        typeof options?.metadata?.workflowId === "string" ? options.metadata.workflowId : undefined;
      const rawId =
        idempotencyKey ?? `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const id = taskId(rawId);
      const task = buildTask(id, agentId, input, mode, options);

      const messages = mapEngineInputToMessages(input, rawId);
      // Resolve effective options upfront so Temporal always receives the same
      // retry budget that the L0 contract advertises (callers omitting maxRetries
      // must not silently inherit a different Temporal-side default).
      const effectiveMaxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
      // Fingerprint the full request so idempotent replay can detect partial collisions
      // (same stable ID but different input/timeout/retries).
      const inputFingerprint = JSON.stringify(serializeEngineInput(input));
      let replayStatus: WorkflowExecutionStatus | undefined;
      try {
        await config.client.workflow.start(workflowType, {
          taskQueue: config.taskQueue,
          workflowId: rawId,
          // Full request fingerprint in memo — used to reject collisions on replay.
          memo: {
            agentId,
            mode,
            workflowType,
            taskQueue: config.taskQueue,
            inputFingerprint,
            maxRetries: effectiveMaxRetries,
            ...(options?.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
          },
          args: [{ agentId, sessionId: rawId, messages, mode }],
          ...(options?.delayMs !== undefined && { startDelay: options.delayMs }),
          ...(options?.timeoutMs !== undefined && { workflowExecutionTimeout: options.timeoutMs }),
          retryPolicy: { maximumAttempts: effectiveMaxRetries },
        });
      } catch (e: unknown) {
        // Stable ID provided and Temporal already has that workflow →
        // idempotent replay (caller retried after a lost response).
        if (idempotencyKey === undefined || !isAlreadyExistsError(e)) throw e;
        // Ownership MUST be verified — fail closed if describe is not configured.
        const describeFn = config.client.workflow.describe;
        if (describeFn === undefined) {
          throw new Error(
            `Stable workflow "${rawId}" already exists but describe() is not configured — cannot verify ownership`,
          );
        }
        replayStatus = await verifyWorkflowOwnership(describeFn, rawId, {
          agentId,
          mode,
          workflowType,
          taskQueue: config.taskQueue,
          inputFingerprint,
          timeoutMs: options?.timeoutMs,
          maxRetries: effectiveMaxRetries,
        });
      }

      // For idempotent replays of terminal workflows, do not register a phantom
      // pending task — the workflow already finished and there is no active execution.
      if (replayStatus !== undefined) {
        const s = replayStatus.status;
        if (s !== "RUNNING" && s !== "CONTINUED_AS_NEW") return id;
      }

      // Guard against double-registration from concurrent or replayed submits.
      if (!tasks.has(id)) {
        tasks.set(id, task);
        emit({ kind: "task:submitted", task });
      }
      return id;
    },

    async cancel(id): Promise<boolean> {
      if (!tasks.has(id)) {
        const describeFn = config.client.workflow.describe;
        if (describeFn !== undefined) {
          const info = await describeFn(String(id)); // throws → propagate
          const m = info.memo;
          if (m?.workflowType !== workflowType || m?.taskQueue !== config.taskQueue) {
            throw new Error(`Operation refused: "${String(id)}" not owned by this scheduler`);
          }
        }
      }
      try {
        await config.client.workflow.cancel(id);
        const task = tasks.get(id);
        if (task !== undefined) {
          const now = Date.now();
          const startedAt = task.startedAt ?? task.createdAt;
          history.push({
            taskId: id,
            agentId: task.agentId,
            status: "failed",
            startedAt,
            completedAt: now,
            durationMs: now - startedAt,
            error: "workflow cancelled",
            retryAttempt: task.retries,
          });
          tasks.delete(id);
          emit({ kind: "task:cancelled", taskId: id });
        }
        return true;
      } catch (_e: unknown) {
        return false;
      }
    },

    async schedule(expression, agentId, input, mode, options): Promise<ScheduleId> {
      // Callers may supply metadata.scheduleId for a stable, retry-safe ID.
      const idempotencyKey =
        typeof options?.metadata?.scheduleId === "string" ? options.metadata.scheduleId : undefined;
      const rawId =
        idempotencyKey ?? `sched-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const id = scheduleId(rawId);

      // Resolve effective options upfront so Temporal always receives the same
      // retry budget that the L0 contract advertises.
      const effectiveMaxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
      // Fingerprint the full request so idempotent replay can detect partial collisions.
      const inputFingerprint = JSON.stringify(serializeEngineInput(input));
      try {
        await config.client.schedule.create(rawId, {
          spec: { cronExpressions: [expression], timezone: options?.timezone },
          action: {
            type: "startWorkflow",
            workflowType,
            taskQueue: config.taskQueue,
            // Pass serialized engine input rather than pre-computed messages so each
            // cron firing constructs per-run message IDs and timestamps from
            // its own Temporal workflowId/execution time. Pre-computing messages
            // here would bake in IDs and timestamps shared by all future runs.
            // sessionId is absent for the same reason: each firing derives its
            // session from workflowInfo().workflowId.
            // serializeEngineInput strips non-serializable runtime fields
            // (callHandlers) that would cause Temporal JSON serialization to fail.
            args: [{ agentId, input: serializeEngineInput(input), mode }],
            ...(options?.timeoutMs !== undefined && {
              workflowExecutionTimeout: options.timeoutMs,
            }),
            retryPolicy: { maximumAttempts: effectiveMaxRetries },
          },
          // Full request fingerprint in memo — used to reject collisions on replay.
          memo: {
            agentId,
            mode,
            workflowType,
            taskQueue: config.taskQueue,
            expression,
            inputFingerprint,
            maxRetries: effectiveMaxRetries,
            ...(options?.timezone !== undefined && { timezone: options.timezone }),
            ...(options?.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
          },
        });
      } catch (e: unknown) {
        // Stable ID provided and Temporal already has that schedule →
        // idempotent replay (caller retried after a lost response).
        if (idempotencyKey === undefined || !isAlreadyExistsError(e)) throw e;
        // Ownership MUST be verified — fail closed if get is not configured.
        const getFn = config.client.schedule.get;
        if (getFn === undefined) {
          throw new Error(
            `Stable schedule "${rawId}" already exists but schedule.get() is not configured — cannot verify ownership`,
          );
        }
        await verifyScheduleOwnership(getFn, rawId, {
          agentId,
          mode,
          workflowType,
          taskQueue: config.taskQueue,
          expression,
          timezone: options?.timezone,
          inputFingerprint,
          timeoutMs: options?.timeoutMs,
          maxRetries: effectiveMaxRetries,
        });
      }

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
      // Guard against double-registration on idempotent replay.
      if (!schedules.has(id)) {
        schedules.set(id, cronSchedule);
        emit({ kind: "schedule:created", schedule: cronSchedule });
      }
      return id;
    },

    async unschedule(id): Promise<boolean> {
      if (!schedules.has(id)) {
        const getFn = config.client.schedule.get;
        if (getFn !== undefined) {
          const info = await getFn(String(id)); // throws → propagate
          const m = info.memo;
          if (m?.workflowType !== workflowType || m?.taskQueue !== config.taskQueue) {
            throw new Error(`Operation refused: "${String(id)}" not owned by this scheduler`);
          }
        }
      }
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
      if (!schedules.has(id)) {
        const getFn = config.client.schedule.get;
        if (getFn !== undefined) {
          const info = await getFn(String(id)); // throws → propagate
          const m = info.memo;
          if (m?.workflowType !== workflowType || m?.taskQueue !== config.taskQueue) {
            throw new Error(`Operation refused: "${String(id)}" not owned by this scheduler`);
          }
        }
      }
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
      if (!schedules.has(id)) {
        const getFn = config.client.schedule.get;
        if (getFn !== undefined) {
          const info = await getFn(String(id)); // throws → propagate
          const m = info.memo;
          if (m?.workflowType !== workflowType || m?.taskQueue !== config.taskQueue) {
            throw new Error(`Operation refused: "${String(id)}" not owned by this scheduler`);
          }
        }
      }
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
      if (filter.priority !== undefined) {
        const priority = filter.priority;
        results = results.filter((t) => t.priority === priority);
      }
      if (filter.limit !== undefined) {
        results = results.slice(0, filter.limit);
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

    async history(filter): Promise<readonly TaskRunRecord[]> {
      // Reconcile before reading so completed/failed workflows are moved from
      // `tasks` into `history` before we filter.
      await reconcileAll();
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

    async bootstrap(): Promise<void> {
      const [wfEntries, schedEntries] = await Promise.all([
        config.client.workflow.list?.({ workflowType, taskQueue: config.taskQueue }) ??
          Promise.resolve([]),
        config.client.schedule.list?.() ?? Promise.resolve([]),
      ]);
      for (const entry of wfEntries) {
        const m = entry.status.memo;
        if (m?.workflowType !== workflowType || m?.taskQueue !== config.taskQueue) continue;
        const s = entry.status.status;
        if (s !== "RUNNING" && s !== "CONTINUED_AS_NEW") continue;
        const id = taskId(entry.workflowId);
        if (tasks.has(id)) continue;
        const rawAgentId = typeof m.agentId === "string" ? m.agentId : "";
        const mode = m.mode === "dispatch" ? "dispatch" : "spawn";
        const fp =
          typeof m.inputFingerprint === "string" ? m.inputFingerprint : '{"kind":"text","text":""}';
        tasks.set(id, {
          id,
          agentId: agentId(rawAgentId),
          input: parseStoredEngineInput(fp),
          mode,
          priority: 5,
          status: "running",
          createdAt: entry.status.startTime ?? Date.now(),
          startedAt: entry.status.startTime,
          retries: 0,
          maxRetries: typeof m.maxRetries === "number" ? m.maxRetries : DEFAULT_MAX_RETRIES,
          timeoutMs: typeof m.timeoutMs === "number" ? m.timeoutMs : undefined,
        });
      }
      for (const entry of schedEntries) {
        const m = entry.info.memo;
        if (m?.workflowType !== workflowType || m?.taskQueue !== config.taskQueue) continue;
        const id = scheduleId(entry.scheduleId);
        if (schedules.has(id)) continue;
        const rawAgentId = typeof m.agentId === "string" ? m.agentId : "";
        const mode = m.mode === "dispatch" ? "dispatch" : "spawn";
        const fp =
          typeof m.inputFingerprint === "string" ? m.inputFingerprint : '{"kind":"text","text":""}';
        schedules.set(id, {
          id,
          agentId: agentId(rawAgentId),
          input: parseStoredEngineInput(fp),
          mode,
          expression: typeof m.expression === "string" ? m.expression : "",
          timezone: typeof m.timezone === "string" ? m.timezone : undefined,
          paused: false,
          taskOptions: undefined,
        });
      }
    },

    async [Symbol.asyncDispose](): Promise<void> {
      listeners.clear();
      tasks.clear();
      schedules.clear();
    },
  };
}
