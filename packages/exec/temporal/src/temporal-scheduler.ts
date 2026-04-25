import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
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
  // Schedule IDs that were persisted as a pre-commit intent before remote create.
  // On restart, these are deleted (cleaning any Temporal orphan) and removed from local state.
  readonly pendingScheduleIds: readonly string[];
  // Task IDs for which a dispatch signal was durably confirmed as sent, even if the
  // full post-signal persist failed. On restart, "pending" dispatch tasks in this set
  // are treated as "completed" (not retried), preventing duplicate signal delivery.
  readonly deliveredDispatchIds: readonly string[];
}

const VALID_TASK_STATUSES = new Set<string>([
  "pending",
  "running",
  "completed",
  "failed",
  "dead_letter",
]);
const VALID_HISTORY_STATUSES = new Set<string>(["completed", "failed"]);

function isValidMode(v: unknown): v is "spawn" | "dispatch" {
  return v === "spawn" || v === "dispatch";
}

function isValidInputPayload(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const kind = (v as Record<string, unknown>).kind;
  return kind === "text" || kind === "messages" || kind === "resume";
}

function validatePersistedTask(v: unknown, dbPath: string): PersistedTask {
  if (typeof v !== "object" || v === null) {
    throw new Error(
      `[temporal-scheduler] malformed task record in "${dbPath}" — expected an object`,
    );
  }
  const r = v as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    typeof r.agentId !== "string" ||
    !isValidMode(r.mode) ||
    !isValidInputPayload(r.input) ||
    typeof r.priority !== "number" ||
    typeof r.status !== "string" ||
    !VALID_TASK_STATUSES.has(r.status) ||
    typeof r.createdAt !== "number" ||
    typeof r.retries !== "number" ||
    typeof r.maxRetries !== "number"
  ) {
    throw new Error(
      `[temporal-scheduler] task record "${String(r.id ?? "?")} " in "${dbPath}" is missing required fields or has wrong types. ` +
        "Remove or migrate the file before restarting.",
    );
  }
  return v as PersistedTask;
}

function validatePersistedSchedule(v: unknown, dbPath: string): PersistedSchedule {
  if (typeof v !== "object" || v === null) {
    throw new Error(
      `[temporal-scheduler] malformed schedule record in "${dbPath}" — expected an object`,
    );
  }
  const r = v as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    typeof r.expression !== "string" ||
    typeof r.agentId !== "string" ||
    !isValidInputPayload(r.input) ||
    !isValidMode(r.mode) ||
    typeof r.paused !== "boolean"
  ) {
    throw new Error(
      `[temporal-scheduler] schedule record "${String(r.id ?? "?")} " in "${dbPath}" is missing required fields or has wrong types. ` +
        "Remove or migrate the file before restarting.",
    );
  }
  return v as PersistedSchedule;
}

function validatePersistedState(raw: unknown, dbPath: string): PersistedState {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray((raw as Record<string, unknown>).tasks) ||
    !Array.isArray((raw as Record<string, unknown>).schedules) ||
    !Array.isArray((raw as Record<string, unknown>).taskWorkflowIds) ||
    !Array.isArray((raw as Record<string, unknown>).cancelledTaskIds) ||
    !Array.isArray((raw as Record<string, unknown>).history)
  ) {
    throw new Error(
      `[temporal-scheduler] dbPath "${dbPath}" contains an incompatible snapshot — ` +
        "expected {tasks, schedules, taskWorkflowIds, cancelledTaskIds, history} arrays. " +
        "Remove or migrate the file before restarting.",
    );
  }
  const r = raw as Record<string, unknown>;
  // pendingScheduleIds and deliveredDispatchIds are optional — older snapshots won't have them.
  if (r.pendingScheduleIds !== undefined && !Array.isArray(r.pendingScheduleIds)) {
    throw new Error(
      `[temporal-scheduler] pendingScheduleIds in "${dbPath}" is present but not an array.`,
    );
  }
  if (r.deliveredDispatchIds !== undefined && !Array.isArray(r.deliveredDispatchIds)) {
    throw new Error(
      `[temporal-scheduler] deliveredDispatchIds in "${dbPath}" is present but not an array.`,
    );
  }
  for (const entry of r.tasks as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
      throw new Error(
        `[temporal-scheduler] tasks array in "${dbPath}" has a malformed entry — expected [string, PersistedTask] tuples.`,
      );
    }
    validatePersistedTask(entry[1], dbPath);
  }
  for (const entry of r.schedules as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
      throw new Error(
        `[temporal-scheduler] schedules array in "${dbPath}" has a malformed entry — expected [string, PersistedSchedule] tuples.`,
      );
    }
    validatePersistedSchedule(entry[1], dbPath);
  }
  for (const entry of r.taskWorkflowIds as unknown[]) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    ) {
      throw new Error(
        `[temporal-scheduler] taskWorkflowIds in "${dbPath}" has a malformed entry — expected [string, string] tuples.`,
      );
    }
  }
  for (const entry of r.cancelledTaskIds as unknown[]) {
    if (typeof entry !== "string") {
      throw new Error(
        `[temporal-scheduler] cancelledTaskIds in "${dbPath}" has a non-string entry.`,
      );
    }
  }
  for (const entry of (r.history ?? []) as unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`[temporal-scheduler] history in "${dbPath}" has a non-object entry.`);
    }
    const h = entry as Record<string, unknown>;
    if (
      typeof h.taskId !== "string" ||
      typeof h.agentId !== "string" ||
      typeof h.status !== "string" ||
      !VALID_HISTORY_STATUSES.has(h.status) ||
      typeof h.startedAt !== "number" ||
      typeof h.completedAt !== "number"
    ) {
      throw new Error(
        `[temporal-scheduler] history record in "${dbPath}" is missing required fields or has invalid status "${String(h.status)}". ` +
          "Remove or migrate the file before restarting.",
      );
    }
  }
  return raw as PersistedState;
}

function loadStateSync(dbPath: string): PersistedState | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(dbPath, "utf8"));
    return validatePersistedState(raw, dbPath);
  } catch (err: unknown) {
    // File not found is normal on first run — return empty state.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // File exists but cannot be read, parsed, or validated — fail loudly so the operator
    // is alerted rather than silently booting with empty/stale state.
    if (err instanceof Error && err.message.includes("incompatible snapshot")) throw err;
    throw new Error(
      `[temporal-scheduler] dbPath "${dbPath}" cannot be loaded — ` +
        "fix or remove the file before restarting. " +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
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

// Sanitize a workflow result before storing it in history so a single cyclic
// or unserializable result cannot poison all future persistence writes.
// Returns a clean JSON-round-tripped clone, or a sentinel string on failure.
function sanitizeResult(result: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(result, persistenceReplacer)) as unknown;
  } catch {
    return "[temporal-scheduler: result was not JSON-serializable and has been omitted]";
  }
}

// Atomic write: write to a temp file, fsync it, rename, then fsync the parent
// directory so the rename itself is durable. Without these fsyncs a kernel
// panic between writeFileSync and rename can leave the old snapshot on disk
// even though the caller received a "success" return — exactly the durability
// gap that makes restart recovery unreliable after a host crash.
function saveStateSync(dbPath: string, state: PersistedState): void {
  const tmp = `${dbPath}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, persistenceReplacer));
    // Flush file data to disk before rename so a crash after rename still
    // returns a consistent new snapshot rather than partially-written data.
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, dbPath);
    // Flush the directory entry so the rename itself is crash-visible.
    const dirFd = openSync(dirname(dbPath), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (err: unknown) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup of orphaned temp file
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// PID-based advisory lock for dbPath (single-writer invariant)
// ---------------------------------------------------------------------------

// Returns true when a process with the given PID is alive in this OS session.
// Uses signal 0 — sends no signal but checks process existence via the kernel.
// On POSIX: throws ESRCH if pid is not found, EPERM if found but not owned.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireDbLock(dbPath: string): void {
  const lockPath = `${dbPath}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | undefined;
    try {
      // 'wx' = O_WRONLY | O_CREAT | O_EXCL — atomic on POSIX; fails EEXIST if another holder created the file.
      fd = openSync(lockPath, "wx");
      // Write PID through the same fd before closing so the file is never empty.
      // An empty lock file would be misread as stale by competing processes.
      writeSync(fd, String(process.pid));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      return;
    } catch (err: unknown) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    // EEXIST: lock file exists — check whether the holder is alive.
    let existingPid: number | undefined;
    try {
      existingPid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    } catch {
      // Lock file vanished between the open and the read — retry the atomic create.
      continue;
    }
    if (!Number.isNaN(existingPid) && isProcessAlive(existingPid)) {
      throw new Error(
        `[temporal-scheduler] dbPath "${dbPath}" is already held by PID ${existingPid}. ` +
          "Only one scheduler instance may write to a given dbPath at a time. " +
          "Stop the other process or remove the stale lock file to continue.",
      );
    }
    // Stale lock — unlink and retry the atomic O_EXCL create.
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore — another process may have won the race */
    }
  }
  throw new Error(
    `[temporal-scheduler] Failed to acquire lock for "${dbPath}" after 2 attempts. ` +
      "Another process may be starting concurrently. Try again.",
  );
}

function releaseDbLock(dbPath: string): void {
  const lockPath = `${dbPath}.lock`;
  // Only remove the lock file if it still contains our PID (guard against a race
  // where a stale-lock cleanup overwrote our entry and another process already holds it).
  try {
    const held = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    if (held === process.pid) {
      unlinkSync(lockPath);
    }
  } catch {
    // Ignore — lock file may have already been removed.
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
  // Schedule IDs that were persisted as a pre-commit intent before remote create.
  // On restart these are cleaned up (remote delete + local removal) to handle orphans.
  const pendingScheduleIds = new Set<string>();
  // Dispatch task IDs for which the signal was durably confirmed as sent (written to disk
  // immediately after workflow.signal() succeeds). Prevents dispatch retry after restart
  // for tasks whose signal was delivered even if the post-signal full-state persist failed.
  const deliveredDispatchIds = new Set<string>();
  // Set on disposal so stale getResult callbacks cannot mutate or persist after shutdown.
  let disposed = false;
  // Set when a background persist fails so subsequent mutations throw rather than silently
  // diverging. Once tripped, the scheduler is fail-closed — no further state mutations.
  let durabilityFailed = false;
  // Tracks the startup orphan-schedule cleanup task so asyncDispose can await its completion
  // before releasing the dbPath lock. Prevents a stale background writer from clobbering
  // a new owner's recovered state after a fast restart/replace cycle.
  let startupCleanupPromise: Promise<void> | undefined;

  // Restore state from disk if dbPath is configured and a prior snapshot exists.
  // Acquire the advisory lock before reading so only one writer can own this dbPath.
  // Release the lock on any startup failure so the process can retry without needing
  // manual intervention to remove a stale lock file.
  if (config.dbPath !== undefined) {
    acquireDbLock(config.dbPath);
    try {
      const saved = loadStateSync(config.dbPath);
      if (saved !== undefined) {
        for (const [k, v] of saved.tasks) tasks.set(k, reconstructTask(v));
        for (const [k, v] of saved.taskWorkflowIds) taskWorkflowIds.set(k, v);
        for (const id of saved.cancelledTaskIds) cancelledTaskIds.add(id);
        for (const [k, v] of saved.schedules) schedules.set(k, reconstructSchedule(v));
        for (const record of saved.history) history.push(record);
        for (const id of saved.pendingScheduleIds ?? []) pendingScheduleIds.add(id);
        for (const id of saved.deliveredDispatchIds ?? []) deliveredDispatchIds.add(id);
      }
    } catch (startupErr: unknown) {
      releaseDbLock(config.dbPath);
      throw startupErr;
    }
  }

  function persist(): void {
    if (config.dbPath === undefined) return;
    // Skip persist after disposal — the lock has been or is about to be released, and writing
    // now would clobber a new owner's recovered state.
    if (disposed) return;
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
        pendingScheduleIds: [...pendingScheduleIds],
        deliveredDispatchIds: [...deliveredDispatchIds],
      });
    } catch (err: unknown) {
      // Trip the fail-closed guard regardless of whether this is a foreground or background
      // call — any persist failure after a remote mutation leaves durable state stale.
      durabilityFailed = true;
      // Re-throw so the mutating API call (submit/schedule/cancel/…) surfaces the error to
      // the caller. The remote Temporal operation may already have succeeded at this point, so
      // the error message states that explicitly to help operators distinguish the failure mode.
      throw new Error(
        "[temporal-scheduler] durability write failed — the Temporal operation was accepted " +
          "but state tracking could not be persisted. Restart recovery may be incomplete. " +
          `Cause: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  function emit(event: SchedulerEvent): void {
    for (const listener of eventListeners) {
      listener(event);
    }
  }

  function assertDurabilityOk(): void {
    if (durabilityFailed) {
      throw new Error(
        "[temporal-scheduler] scheduler is fail-closed due to a previous persistence failure — " +
          "restart the process after fixing the underlying storage issue before issuing new mutations.",
      );
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

  // On restart, clean up pending schedule IDs: try to delete any orphaned Temporal schedule
  // that was created before a crash (between remote create and local persist). Only remove the
  // pending marker after a CONFIRMED delete so a transient Temporal failure does not permanently
  // lose track of a live recurring schedule. Failed IDs stay in pendingScheduleIds and are
  // retried on the next restart.
  if (pendingScheduleIds.size > 0) {
    startupCleanupPromise = (async () => {
      let anyCleared = false;
      for (const id of [...pendingScheduleIds]) {
        try {
          await config.client.schedule.delete(id);
          schedules.delete(id);
          pendingScheduleIds.delete(id);
          anyCleared = true;
        } catch {
          // Delete failed (transient error or schedule already gone) — retain the ID so
          // the next restart retries. The cost is one extra no-op delete per restart if the
          // schedule never existed, which is acceptable compared to permanently forgetting a
          // live schedule.
        }
      }
      if (anyCleared && config.dbPath !== undefined) {
        try {
          persist();
        } catch (e) {
          durabilityFailed = true;
          console.error(
            "[temporal-scheduler] background persist after pending-schedule cleanup failed:",
            e,
          );
        }
      }
    })();
  }

  // Mark "pending" dispatch tasks on restart. Two cases:
  // 1. deliveredDispatchIds contains the task ID → signal was durably confirmed as sent
  //    (intermediate persist succeeded before the full post-signal persist failed).
  //    Record as "completed" to suppress retry — the signal was already delivered.
  // 2. Not in deliveredDispatchIds → crash occurred before or during signal send.
  //    Record as "failed" (retryable) — the signal may not have been sent.
  for (const [taskId, task] of tasks) {
    if (task.mode !== "dispatch" || task.status !== "pending") continue;
    const completedAt = Date.now();
    const signalWasDelivered = deliveredDispatchIds.has(taskId);
    if (signalWasDelivered) {
      tasks.set(taskId, { ...task, status: "completed", completedAt });
      history.push({
        taskId: taskId as TaskId,
        agentId: task.agentId,
        status: "completed",
        startedAt: task.startedAt ?? task.createdAt,
        completedAt,
        durationMs: completedAt - (task.startedAt ?? task.createdAt),
        retryAttempt: 0,
      });
      deliveredDispatchIds.delete(taskId); // history now records completion
    } else {
      tasks.set(taskId, { ...task, status: "failed", completedAt });
      history.push({
        taskId: taskId as TaskId,
        agentId: task.agentId,
        status: "failed",
        startedAt: task.startedAt ?? task.createdAt,
        completedAt,
        durationMs: completedAt - (task.startedAt ?? task.createdAt),
        error: "signal delivery status unknown after process restart",
        retryAttempt: 0,
      });
    }
  }

  // Reattach getResult watchers for spawn tasks that were running or pending at the time of
  // a previous shutdown, so completion/failure events are recorded after restart.
  // "pending" tasks had their workflow started but the process crashed before persisting "running".
  // getResult on a non-existent workflow rejects → task is marked failed (no orphan).
  for (const [taskId, task] of tasks) {
    if (task.mode !== "spawn" || (task.status !== "running" && task.status !== "pending")) continue;
    const workflowId = taskWorkflowIds.get(taskId) ?? taskId;
    const startedAt = task.startedAt ?? task.createdAt;
    const agentId = task.agentId;
    void config.client.workflow.getResult(workflowId).then(
      (result: unknown) => {
        if (disposed || cancelledTaskIds.has(taskId)) return;
        const completedAt = Date.now();
        const safeResult = sanitizeResult(result);
        tasks.set(taskId, { ...task, status: "completed", completedAt });
        history.push({
          taskId: taskId as TaskId,
          agentId,
          status: "completed",
          startedAt,
          completedAt,
          durationMs: completedAt - startedAt,
          result: safeResult,
          retryAttempt: 0,
        });
        emit({ kind: "task:completed", taskId: taskId as TaskId, result: safeResult });
        try {
          persist();
        } catch (e) {
          durabilityFailed = true;
          console.error(
            "[temporal-scheduler] background persist failed — scheduler is now fail-closed:",
            e,
          );
        }
      },
      (error: unknown) => {
        if (disposed || cancelledTaskIds.has(taskId)) return;
        const completedAt = Date.now();
        const koiError: KoiError = {
          code: "EXTERNAL",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          context: { taskId, agentId },
        };
        tasks.set(taskId, { ...task, status: "failed", completedAt });
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
        try {
          persist();
        } catch (e) {
          durabilityFailed = true;
          console.error(
            "[temporal-scheduler] background persist failed — scheduler is now fail-closed:",
            e,
          );
        }
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
      assertDurabilityOk();
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
      // Validate metadata before the remote call so a non-serializable value does not cause
      // persist() to fail after the workflow has already been accepted by Temporal.
      if (options?.metadata !== undefined) {
        assertJsonSafeValue(options.metadata, "options.metadata");
        assertJsonSerializable(options.metadata);
      }
      // Validate the input payload before the remote call — matches the schedule() path.
      // A non-serializable resume.state (or message content) must be rejected up front
      // rather than discovered during persist() after the workflow has already been accepted.
      assertJsonSerializable(mapEngineInputToScheduledPayload(input));

      // Use caller-supplied idempotency key as the task ID so message IDs derived from it
      // are stable across retries, enabling workflow-side deduplication after ACK-lost failures.
      // Namespace by agentId + mode so keys from different agents or modes never collide.
      const id = toTaskId(
        options?.idempotencyKey !== undefined
          ? `${agentId}:${mode}:${options.idempotencyKey}`
          : `task:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`,
      );
      const now = Date.now();

      // Idempotency guard: short-circuit only for in-flight or successfully completed tasks.
      // Failed tasks are allowed to be retried with the same key — the prior attempt did not
      // produce durable remote work so the caller's retry is legitimate, not a duplicate.
      if (options?.idempotencyKey !== undefined) {
        const existing = tasks.get(id);
        if (existing !== undefined && existing.status !== "failed") {
          return id; // in-flight (pending/running) or completed — no-op
        }
        const priorSuccess = history.some((r) => r.taskId === id && r.status === "completed");
        if (priorSuccess) {
          return id; // already succeeded — no-op
        }
        // If existing is "failed" or only in history as "failed": fall through and retry.
        // Before retrying, clear the cancellation guard so that a prior cancel() call does
        // not permanently block the retried getResult() callback from recording completion.
        cancelledTaskIds.delete(id);
      }

      // Snapshot: deep-clone via JSON round-trip to prevent caller mutations from poisoning
      // future persist() calls after the remote operation already succeeded. Already validated
      // as JSON-serializable above so the round-trip cannot throw.
      const snapshotInput = JSON.parse(
        JSON.stringify(mapEngineInputToScheduledPayload(input)),
      ) as EngineInput;
      const snapshotMetadata =
        options?.metadata !== undefined
          ? (JSON.parse(JSON.stringify(options.metadata)) as Record<string, unknown>)
          : undefined;

      const task: ScheduledTask = {
        id,
        agentId,
        input: snapshotInput,
        mode,
        priority: options?.priority ?? 5,
        status: "pending",
        createdAt: now,
        scheduledAt: options?.delayMs !== undefined ? now + options.delayMs : undefined,
        retries: 0,
        maxRetries: options?.maxRetries ?? 3,
        timeoutMs: options?.timeoutMs,
        metadata: snapshotMetadata,
      };

      const messages = mapEngineInputToMessages(snapshotInput, id);

      // Two-phase pre-commit: durably record the "pending" intent before making the remote call.
      // For spawn: if the process crashes between workflow.start() and the post-start persist(),
      //   the "pending" task on disk lets startup reconciliation reattach getResult and recover.
      // For dispatch: if persist() fails AFTER the signal is delivered, NOT rethrowing means
      //   the caller sees success and does NOT retry — preventing a duplicate signal that would
      //   have worse consequences than a missing audit record. durabilityFailed is still tripped
      //   by persist(), so the next mutation fails-closed. On restart, "pending" dispatch tasks
      //   are marked failed (signal delivery unknown) so they don't silently hide past state.
      const preCommitWorkflowId = mode === "spawn" ? id : String(agentId);
      tasks.set(id, task);
      taskWorkflowIds.set(id, preCommitWorkflowId);
      try {
        persist();
      } catch (preCommitErr: unknown) {
        tasks.delete(id);
        taskWorkflowIds.delete(id);
        throw preCommitErr; // durabilityFailed already set by persist(); no remote call made
      }

      // Initialize to id so the rollback cancel uses the requested workflowId even if start() throws
      // before handle.workflowId is assigned.
      let targetWorkflowId: string = id;
      try {
        if (mode === "spawn") {
          const handle = await config.client.workflow.start(config.workflowType, {
            taskQueue: config.taskQueue,
            workflowId: id,
            args: [
              {
                agentId,
                sessionId: id,
                stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
                initialMessages: messages,
              },
            ],
            ...(options?.delayMs !== undefined ? { startDelay: `${options.delayMs}ms` } : {}),
          });
          targetWorkflowId = handle.workflowId;
        } else {
          // dispatch: target the long-running workflow for this agent.
          // Send the whole batch in one signal so delivery is atomic — a partial message
          // set cannot be observed and retries produce no duplicates.
          targetWorkflowId = String(agentId);
          await config.client.workflow.signal(targetWorkflowId, "messages", messages);
        }
      } catch (err: unknown) {
        // For idempotent spawn (idempotencyKey present), skip the cancel rollback entirely.
        // The failure may be an ACK-lost transient — Temporal may have created the workflow.
        // Cancelling would kill a live execution. Instead, mark as failed (retryable) so the
        // caller can retry; the retry will hit "already running" and take the idempotent attach path.
        const skipCancel = mode === "spawn" && options?.idempotencyKey !== undefined;
        let rollbackOk = true;
        if (mode === "spawn" && !skipCancel) {
          try {
            await config.client.workflow.cancel(targetWorkflowId);
          } catch {
            rollbackOk = false;
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
        emit({ kind: "task:submitted", task: Object.freeze({ ...failedTask }) });
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
        try {
          persist();
        } catch {
          // Persist failure already trips durabilityFailed — swallow here so the
          // original submit error is what surfaces to the caller.
        }
        if (!rollbackOk) {
          throw new Error(
            `submit() failed AND rollback cancel failed — workflowId "${targetWorkflowId}" ` +
              `may still be running for agent ${agentId}. Manually cancel it before retrying. ` +
              `Cause: ${errorMsg}`,
            { cause: err },
          );
        }
        throw new Error(`submit() could not reach Temporal for agent ${agentId}: ${errorMsg}`, {
          cause: err,
        });
      }

      // Remote calls succeeded — emit submitted then handle mode-specific lifecycle.
      taskWorkflowIds.set(id, targetWorkflowId);
      tasks.set(id, task);
      emit({ kind: "task:submitted", task: Object.freeze({ ...task }) });

      if (mode === "dispatch") {
        // Dispatch: signal delivered to Temporal is the extent of scheduler responsibility.
        // We cannot know when the target workflow completes, so we do not publish a terminal
        // `task:completed` event and do not hold the task in `tasks` map — that would
        // misrepresent outcome to query()/stats(). The history record preserves the audit trail.

        // Write a durable "signal delivered" marker — this persist is mandatory. If it fails
        // we cannot guarantee restart-safe idempotency, so we surface a durability error and
        // abort without proceeding to history cleanup. The marker stays in memory so any
        // future successful persist (e.g. once disk is healthy again) can establish safety.
        // We do NOT throw here because throwing causes the caller to retry with a new task ID,
        // which would produce a duplicate signal. Instead, emit task:failed and return.
        deliveredDispatchIds.add(id);
        try {
          persist();
        } catch (markerPersistErr: unknown) {
          const durabilityMsg =
            `[temporal-scheduler] dispatch marker persist failed for task "${id}" — signal was ` +
            "accepted by Temporal but idempotency cannot be guaranteed across restart. " +
            "Scheduler is now fail-closed.";
          console.error(durabilityMsg, markerPersistErr);
          const koiErr: KoiError = {
            code: "INTERNAL",
            message: durabilityMsg,
            retryable: false,
            context: { taskId: id, agentId: String(agentId), signalDelivered: true },
          };
          emit({ kind: "task:failed", taskId: id, error: koiErr });
          // Return early — marker stays in memory; history/cleanup skipped to preserve
          // task in the persisted state (pending) so restart reconciliation can reason about it.
          return id;
        }

        // Marker persisted — safe to proceed with history update and cleanup.
        const completedAt = Date.now();
        history.push({
          taskId: id,
          agentId,
          status: "completed",
          startedAt: now,
          completedAt,
          durationMs: completedAt - now,
          retryAttempt: 0,
        });
        tasks.delete(id);
        taskWorkflowIds.delete(id);
        // Only delete the marker after it has been superseded by a history record in the
        // final persist. If that persist fails, we re-add the marker so the in-memory set
        // still reflects delivered state for any future persist that succeeds.
        // Do NOT rethrow on persist failure: the signal was already accepted by Temporal.
        // Rethrowing causes the caller to retry with a new ID, producing a duplicate signal.
        try {
          deliveredDispatchIds.delete(id);
          persist();
        } catch (persistErr: unknown) {
          // Final persist failed — restore marker so a future persist can establish safety.
          deliveredDispatchIds.add(id);
          const durabilityMsg =
            `[temporal-scheduler] post-dispatch persist failed — signal for task "${id}" was ` +
            "accepted by Temporal but local history is not durable. Scheduler is now fail-closed.";
          console.error(durabilityMsg, persistErr);
          const koiErr: KoiError = {
            code: "INTERNAL",
            message: durabilityMsg,
            retryable: false,
            context: { taskId: id, agentId: String(agentId), signalDelivered: true },
          };
          emit({ kind: "task:failed", taskId: id, error: koiErr });
        }
      } else {
        // Spawn: track actual workflow completion via getResult.
        // Gate on cancelledTaskIds so a raced cancel wins and prevents double terminal events.
        const startedAt = Date.now();
        const runningTask: ScheduledTask = { ...task, status: "running", startedAt };
        tasks.set(id, runningTask);
        // Attach the watcher BEFORE persist so we never lose tracking of a live workflow.
        // If persist subsequently fails, we cancel the workflow and re-throw rather than
        // leaving it running without local observability or restart-recovery coverage.
        void config.client.workflow.getResult(targetWorkflowId).then(
          (result: unknown) => {
            if (disposed || cancelledTaskIds.has(id)) return;
            const completedAt = Date.now();
            const safeResult = sanitizeResult(result);
            tasks.set(id, { ...runningTask, status: "completed", completedAt });
            history.push({
              taskId: id,
              agentId,
              status: "completed",
              startedAt,
              completedAt,
              durationMs: completedAt - startedAt,
              result: safeResult,
              retryAttempt: 0,
            });
            emit({ kind: "task:completed", taskId: id, result: safeResult });
            try {
              persist();
            } catch (e) {
              durabilityFailed = true;
              console.error(
                "[temporal-scheduler] background persist failed — scheduler is now fail-closed:",
                e,
              );
            }
          },
          (error: unknown) => {
            if (disposed || cancelledTaskIds.has(id)) return;
            const completedAt = Date.now();
            tasks.set(id, { ...runningTask, status: "failed", completedAt });
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
            try {
              persist();
            } catch (e) {
              durabilityFailed = true;
              console.error(
                "[temporal-scheduler] background persist failed — scheduler is now fail-closed:",
                e,
              );
            }
          },
        );
        // Persist the running state. If the write fails, cancel the workflow so we never
        // have a live remote workflow without local tracking or restart-recovery coverage.
        try {
          persist();
        } catch (persistErr: unknown) {
          let cancelOk = true;
          try {
            await config.client.workflow.cancel(targetWorkflowId);
          } catch {
            cancelOk = false;
          }
          if (!cancelOk) {
            // Both persist and rollback-cancel failed: surface the workflow ID so operators
            // can manually cancel the orphaned execution.
            throw new Error(
              `[temporal-scheduler] durability write failed AND rollback cancel failed — ` +
                `workflowId "${targetWorkflowId}" may still be running. ` +
                "Manually cancel it before retrying. " +
                `Persist cause: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
              { cause: persistErr },
            );
          }
          // Rollback-cancel succeeded — remove the phantom task so query()/stats()
          // do not show a running task for a submission that was already rolled back.
          tasks.delete(id);
          taskWorkflowIds.delete(id);
          throw persistErr;
        }
      }

      return id;
    },

    async cancel(id: TaskId): Promise<boolean> {
      assertDurabilityOk();
      const task = tasks.get(id);
      if (task === undefined) return false;
      // Dispatch signals are delivered immediately; there is no workflow-level cancel
      // that targets only this task. Cancelling the agent workflow ID would destroy
      // all in-flight work for that agent, not just this task.
      if (task.mode === "dispatch") return false;
      const targetId = taskWorkflowIds.get(id) ?? id;
      // Mark cancelled before the remote call so any concurrent getResult
      // handler that fires during or after sees the cancelled gate first.
      cancelledTaskIds.add(id);
      try {
        await config.client.workflow.cancel(targetId);
      } catch {
        // Remote cancel failed — remove the guard and report failure.
        cancelledTaskIds.delete(id);
        return false;
      }
      // Remote cancel succeeded — update local state and persist.
      // Keep the cancellation guard set even if persist fails: reporting false
      // while the workflow is already cancelled would mislead the caller and
      // allow stale getResult callbacks to overwrite the cancelled status.
      tasks.set(id, { ...task, status: "failed" });
      emit({ kind: "task:cancelled", taskId: id });
      persist(); // propagates durability failure as an exception
      return true;
    },

    async schedule(
      expression: string,
      agentId: AgentId,
      input: EngineInput,
      mode: "spawn" | "dispatch",
      options?: TaskOptions & { readonly timezone?: string | undefined },
    ): Promise<ScheduleId> {
      assertDurabilityOk();
      // timeoutMs, maxRetries, delayMs, priority, and metadata cannot be plumbed into Temporal
      // schedule policies — accepting them silently would give callers a false guarantee that
      // these options survive persistence and affect fired executions.
      if (
        options?.timeoutMs !== undefined ||
        options?.maxRetries !== undefined ||
        options?.delayMs !== undefined ||
        options?.priority !== undefined ||
        options?.metadata !== undefined
      ) {
        throw new Error(
          "schedule() does not support timeoutMs, maxRetries, delayMs, priority, or metadata — " +
            "these options cannot be persisted or enforced by Temporal schedule policies. " +
            "Remove them or implement the constraints inside the target workflow.",
        );
      }

      const id = toScheduleId(`sched:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`);

      // Strip non-serializable EngineInput fields and deep-validate JSON safety.
      // Done before building the schedule object so the snapshot is validated.
      const scheduledPayload = mapEngineInputToScheduledPayload(input);
      assertJsonSerializable(scheduledPayload);
      // Deep-clone via JSON round-trip to prevent caller mutations from poisoning future
      // persist() calls. Already validated as JSON-serializable above.
      const snapshotPayload = JSON.parse(JSON.stringify(scheduledPayload)) as EngineInput;

      const schedule: CronSchedule = {
        id,
        expression,
        agentId,
        input: snapshotPayload,
        mode,
        taskOptions: options,
        timezone: options?.timezone,
        paused: false,
      };

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
          // ALLOW_DUPLICATE lets each cron firing start a fresh workflow even if one with
          // the same ID completed previously (unlike the default REJECT_DUPLICATE).
          workflowIdReusePolicy: "ALLOW_DUPLICATE",
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

      // Two-phase pre-commit: durably record the schedule ID as "pending" before calling
      // schedule.create() so a crash between create() and the post-create persist() is
      // recoverable. On restart, pendingScheduleIds cleanup deletes the orphaned schedule
      // (a no-op if create() never completed), preventing duplicate recurring executions.
      pendingScheduleIds.add(id);
      try {
        persist();
      } catch (preCommitErr: unknown) {
        pendingScheduleIds.delete(id);
        throw preCommitErr; // durabilityFailed already set
      }

      try {
        await config.client.schedule.create(id, {
          spec: {
            cronExpressions: [expression],
            ...(options?.timezone !== undefined ? { timezone: options.timezone } : {}),
          },
          action: scheduleAction,
          // SKIP prevents concurrent firings from piling up if a run overruns its interval.
          // Safe for both spawn (each firing = distinct workflow) and dispatch (signal is idempotent).
          policies: { overlapPolicy: "SKIP" },
        });
      } catch (createErr: unknown) {
        // create() may have succeeded even if the client saw an error (ACK lost on timeout/reset).
        // Attempt a best-effort compensating delete. Only clear pendingScheduleIds if the delete
        // succeeds — if it fails (transient or schedule genuinely absent), retain the marker so
        // startup reconciliation can retry the delete rather than permanently forgetting a live cron.
        let deleteConfirmed = false;
        try {
          await config.client.schedule.delete(id);
          deleteConfirmed = true;
        } catch {
          // Inconclusive: may be "not found" (create never completed) or transient failure.
          // Keep pendingScheduleIds so the next restart retries.
        }
        if (deleteConfirmed) {
          pendingScheduleIds.delete(id);
          try {
            persist(); // clear the pre-commit intent from disk
          } catch {
            // durabilityFailed already set; swallow so the original createErr surfaces
          }
        }
        // If deleteConfirmed is false: pendingScheduleIds still has id; next restart will retry.
        throw createErr;
      }

      schedules.set(id, schedule);
      // Remove from pendingScheduleIds: the schedule is now durably tracked in schedules.
      // If persist() below fails, we restore it so the rollback path and startup cleanup
      // can still remove the orphaned Temporal schedule.
      pendingScheduleIds.delete(id);
      try {
        persist();
      } catch (persistErr: unknown) {
        // Restore so startup cleanup can delete the orphan if the process restarts.
        pendingScheduleIds.add(id);
        // Compensate: delete the remote schedule so a caller retry does not create a second
        // live schedule with a different id. The schedule id is random so retries are not
        // idempotent without this rollback.
        schedules.delete(id);
        let deleteOk = true;
        try {
          await config.client.schedule.delete(id);
        } catch {
          deleteOk = false;
        }
        if (!deleteOk) {
          // Both persist and rollback-delete failed: surface the schedule ID so operators
          // can manually delete the orphaned recurring schedule.
          throw new Error(
            `[temporal-scheduler] durability write failed AND rollback delete failed — ` +
              `scheduleId "${id}" may still be running. ` +
              "Manually delete it before retrying to avoid duplicate executions. " +
              `Persist cause: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
            { cause: persistErr },
          );
        }
        throw persistErr;
      }
      // Emit only after persistence is durable — rolled-back schedules never fire this event.
      emit({ kind: "schedule:created", schedule: Object.freeze({ ...schedule }) });
      return id;
    },

    async unschedule(id: ScheduleId): Promise<boolean> {
      assertDurabilityOk();
      if (!schedules.has(id)) return false;
      try {
        await config.client.schedule.delete(id);
      } catch {
        return false;
      }
      // Remote delete succeeded — update local state and persist.
      // Propagate persist errors rather than collapsing them into `false`:
      // after a successful remote delete, returning false would misrepresent the outcome.
      schedules.delete(id);
      emit({ kind: "schedule:removed", scheduleId: id });
      persist();
      return true;
    },

    async pause(id: ScheduleId): Promise<boolean> {
      assertDurabilityOk();
      const schedule = schedules.get(id);
      if (schedule === undefined) return false;
      try {
        await config.client.schedule.pause(id);
      } catch {
        return false;
      }
      schedules.set(id, { ...schedule, paused: true });
      try {
        persist();
      } catch (persistErr: unknown) {
        let compensated = false;
        try {
          await config.client.schedule.unpause(id);
          compensated = true;
        } catch {
          // compensation failed — remote and on-disk states are now diverged
        }
        schedules.set(id, schedule);
        if (!compensated) {
          throw new Error(
            `[temporal-scheduler] persist failed AND rollback unpause failed for schedule "${id}" — ` +
              "actual remote pause state is unknown. Operator reconciliation required. " +
              `Persist cause: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
            { cause: persistErr },
          );
        }
        throw persistErr;
      }
      // Emit only after persistence is durable so observers see consistent state.
      emit({ kind: "schedule:paused", scheduleId: id });
      return true;
    },

    async resume(id: ScheduleId): Promise<boolean> {
      assertDurabilityOk();
      const schedule = schedules.get(id);
      if (schedule === undefined) return false;
      try {
        await config.client.schedule.unpause(id);
      } catch {
        return false;
      }
      schedules.set(id, { ...schedule, paused: false });
      try {
        persist();
      } catch (persistErr: unknown) {
        let compensated = false;
        try {
          await config.client.schedule.pause(id);
          compensated = true;
        } catch {
          // compensation failed — remote and on-disk states are now diverged
        }
        schedules.set(id, schedule);
        if (!compensated) {
          throw new Error(
            `[temporal-scheduler] persist failed AND rollback pause failed for schedule "${id}" — ` +
              "actual remote resume state is unknown. Operator reconciliation required. " +
              `Persist cause: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
            { cause: persistErr },
          );
        }
        throw persistErr;
      }
      // Emit only after persistence is durable so observers see consistent state.
      emit({ kind: "schedule:resumed", scheduleId: id });
      return true;
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
      // Return deep-frozen copies so callers cannot mutate internal scheduler state
      // through nested references (input, metadata). structuredClone produces a fully
      // independent value; Object.freeze makes the top-level object immutable.
      return result.map((t) => Object.freeze(structuredClone(t)));
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
      return result.map((r) => Object.freeze(structuredClone(r)));
    },

    watch(listener: (event: SchedulerEvent) => void): () => void {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },

    async [Symbol.asyncDispose](): Promise<void> {
      disposed = true;
      eventListeners.clear();
      // Await startup cleanup before releasing the lock. The cleanup task may still be running
      // Temporal schedule deletes; we must let it finish (and its persist() will be a no-op
      // because disposed is now true) before a new owner can safely acquire the dbPath lock.
      if (startupCleanupPromise !== undefined) {
        await startupCleanupPromise.catch(() => {});
      }
      tasks.clear();
      taskWorkflowIds.clear();
      cancelledTaskIds.clear();
      schedules.clear();
      deliveredDispatchIds.clear();
      if (config.dbPath !== undefined) {
        releaseDbLock(config.dbPath);
      }
    },
  };
}
