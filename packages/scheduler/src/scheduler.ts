/**
 * Task scheduler — priority queue, cron scheduling, retry with backoff,
 * dead-letter queue, and bounded concurrency.
 *
 * SQLite is source of truth; in-memory heap is a hot cache of pending tasks.
 */

import type {
  AgentId,
  CronSchedule,
  EngineInput,
  KoiError,
  ScheduledTask,
  ScheduleId,
  SchedulerConfig,
  SchedulerEvent,
  SchedulerStats,
  ScheduleStore,
  TaskFilter,
  TaskHistoryFilter,
  TaskId,
  TaskOptions,
  TaskRunRecord,
  TaskScheduler,
  TaskStore,
} from "@koi/core";
import { scheduleId, taskId } from "@koi/core";
import { Cron } from "croner";
import type { Clock } from "./clock.js";
import { createSystemClock } from "./clock.js";
import { createMinHeap } from "./heap.js";
import { computeRetryDelay } from "./retry.js";
import { createSemaphore } from "./semaphore.js";
import { createPeriodicTimer } from "./timer.js";

// ---------------------------------------------------------------------------
// Task dispatcher signature
// ---------------------------------------------------------------------------

export type TaskDispatcher = (
  agentId: AgentId,
  input: EngineInput,
  mode: "spawn" | "dispatch",
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScheduler(
  config: SchedulerConfig,
  store: TaskStore,
  dispatcher: TaskDispatcher,
  clock?: Clock,
  scheduleStore?: ScheduleStore,
): TaskScheduler {
  const clk = clock ?? createSystemClock();
  let disposed = false; // let: set to true on dispose

  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------

  const heap = createMinHeap<ScheduledTask>((a, b) => {
    const pd = a.priority - b.priority;
    if (pd !== 0) return pd;
    return a.createdAt - b.createdAt;
  });

  const crons = new Map<string, Cron>(); // scheduleId → Cron instance
  const cronMeta = new Map<string, CronSchedule>(); // scheduleId → metadata
  const semaphore = createSemaphore(config.maxConcurrent);
  // P9 fix: mutable Set with idempotent unsubscribe (internal state, not shared)
  const listeners = new Set<(event: SchedulerEvent) => void>();

  // Stats counters
  let completedCount = 0; // let: incremented on task completion
  let failedCount = 0; // let: incremented on task failure
  let deadLetteredCount = 0; // let: incremented on dead letter

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function emit(event: SchedulerEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function generateTaskId(): TaskId {
    return taskId(`task_${clk.now()}_${Math.random().toString(36).slice(2, 10)}`);
  }

  function generateScheduleId(): ScheduleId {
    return scheduleId(`sched_${clk.now()}_${Math.random().toString(36).slice(2, 10)}`);
  }

  /** Race a promise against a clock-based timeout. Returns the result or throws TIMEOUT KoiError. */
  function executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
    if (timeoutMs === undefined) return promise;

    return new Promise<T>((resolve, reject) => {
      let settled = false; // let: guard flag — first settlement wins

      const timerId = clk.setTimeout(() => {
        if (settled) return;
        settled = true;
        const err: KoiError = {
          code: "TIMEOUT",
          message: `Task execution timed out after ${String(timeoutMs)}ms`,
          retryable: true,
        };
        reject(err);
      }, timeoutMs);

      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clk.clearTimeout(timerId);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clk.clearTimeout(timerId);
          reject(error);
        },
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Dispatch a single task
  // ---------------------------------------------------------------------------

  // P2 fix: outer try/catch for infrastructure errors (store failures);
  // re-insert task into heap so it's not silently orphaned.
  async function dispatchTask(task: ScheduledTask): Promise<void> {
    try {
      const now = clk.now();
      await store.updateStatus(task.id, "running", { startedAt: now });
      emit({ kind: "task:started", taskId: task.id });

      try {
        const result = await executeWithTimeout(
          dispatcher(task.agentId, task.input, task.mode),
          task.timeoutMs,
        );

        await store.updateStatus(task.id, "completed", { completedAt: clk.now() });
        completedCount += 1;
        emit({ kind: "task:completed", taskId: task.id, result });
      } catch (err: unknown) {
        // Timeout errors arrive as KoiError objects with code "TIMEOUT"
        const isTimeoutError =
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as KoiError).code === "TIMEOUT";

        const koiError: KoiError = isTimeoutError
          ? (err as KoiError)
          : {
              code: "EXTERNAL",
              message: err instanceof Error ? err.message : String(err),
              retryable: true,
              cause: err,
            };

        const nextRetries = task.retries + 1;
        if (nextRetries < task.maxRetries) {
          // Retry: re-queue with backoff
          const delay = computeRetryDelay(task.retries, config);
          const retask: ScheduledTask = {
            ...task,
            status: "pending",
            retries: nextRetries,
            scheduledAt: clk.now() + delay,
            lastError: koiError,
          };
          await store.save(retask);
          heap.insert(retask);
          failedCount += 1;
          emit({ kind: "task:failed", taskId: task.id, error: koiError });
        } else {
          // Dead letter
          await store.updateStatus(task.id, "dead_letter", {
            lastError: koiError,
            retries: nextRetries,
          });
          deadLetteredCount += 1;
          emit({ kind: "task:dead_letter", taskId: task.id, error: koiError });
        }
      }
    } catch (_infraError: unknown) {
      // Infrastructure failure (store error) — re-insert for retry on next poll
      heap.insert(task);
    } finally {
      semaphore.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Poll loop — process ready tasks from the heap
  // ---------------------------------------------------------------------------

  function poll(): void {
    if (disposed) return;

    const now = clk.now();
    while (true) {
      const next = heap.peek();
      if (next === undefined) break;

      // Check if task is scheduled for future
      if (next.scheduledAt !== undefined && next.scheduledAt > now) break;

      if (!semaphore.acquire()) break;

      const task = heap.extractMin();
      if (task === undefined) {
        semaphore.release();
        break;
      }
      // Fire and forget — errors handled inside dispatchTask
      void dispatchTask(task);
    }
  }

  const pollTimer = createPeriodicTimer(clk, config.pollIntervalMs, poll);

  // ---------------------------------------------------------------------------
  // Initialize: load pending tasks from store into heap
  // ---------------------------------------------------------------------------

  async function initialize(): Promise<void> {
    // Load pending tasks into heap
    const pending = await store.loadPending();
    for (const task of pending) {
      heap.insert(task);
    }

    // Gap 2: recover stale "running" tasks
    const running = await store.query({ status: "running" });
    const now = clk.now();
    for (const task of running) {
      const startedAt = task.startedAt ?? task.createdAt;
      if (now - startedAt < config.staleTaskThresholdMs) continue;

      const nextRetries = task.retries + 1;
      if (nextRetries < task.maxRetries) {
        // Recoverable — reset to pending, increment retries
        const recovered: ScheduledTask = {
          ...task,
          status: "pending",
          retries: nextRetries,
        };
        await store.save(recovered);
        heap.remove((t) => t.id === task.id); // Remove stale version if present
        heap.insert(recovered);
        emit({ kind: "task:recovered", taskId: task.id, retriesUsed: nextRetries });
      } else {
        // Retries exhausted — dead letter
        const koiError: KoiError = {
          code: "TIMEOUT",
          message: "Task stale after crash — retries exhausted",
          retryable: false,
        };
        await store.updateStatus(task.id, "dead_letter", {
          lastError: koiError,
          retries: nextRetries,
        });
        deadLetteredCount += 1;
        emit({ kind: "task:dead_letter", taskId: task.id, error: koiError });
      }
    }

    // Gap 3: restore persisted cron schedules
    if (scheduleStore !== undefined) {
      const schedules = await scheduleStore.loadSchedules();
      for (const meta of schedules) {
        if (meta.paused) continue;
        const cronOptions =
          meta.timezone !== undefined
            ? ({ timezone: meta.timezone, paused: false } as const)
            : ({ paused: false } as const);

        const cronJob = new Cron(meta.expression, cronOptions, () => {
          void submit(meta.agentId, meta.input, meta.mode, meta.taskOptions);
        });

        crons.set(meta.id, cronJob);
        cronMeta.set(meta.id, meta);
      }
    }
  }

  // Start initialization
  const initPromise = initialize();

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  async function submit(
    agentIdVal: AgentId,
    input: EngineInput,
    mode: "spawn" | "dispatch",
    options?: TaskOptions,
  ): Promise<TaskId> {
    if (disposed) {
      throw new Error("Scheduler is disposed");
    }

    await initPromise;

    if (options?.timeoutMs !== undefined && options.timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive number");
    }

    const id = generateTaskId();
    const now = clk.now();
    const task: ScheduledTask = {
      id,
      agentId: agentIdVal,
      input,
      mode,
      priority: options?.priority ?? config.defaultPriority,
      status: "pending",
      createdAt: now,
      scheduledAt: options?.delayMs !== undefined ? now + options.delayMs : undefined,
      retries: 0,
      maxRetries: options?.maxRetries ?? config.defaultMaxRetries,
      timeoutMs: options?.timeoutMs,
      metadata: options?.metadata,
    };

    await store.save(task);
    heap.insert(task);
    emit({ kind: "task:submitted", task });

    // P1 fix: immediately attempt dispatch for zero-delay tasks
    poll();

    return id;
  }

  async function cancel(id: TaskId): Promise<boolean> {
    if (disposed) return false;

    await initPromise;

    const removed = heap.remove((t) => t.id === id);
    if (removed) {
      await store.updateStatus(id, "completed", { completedAt: clk.now() });
      emit({ kind: "task:cancelled", taskId: id });
    }
    return removed;
  }

  async function schedule(
    expression: string,
    agentIdVal: AgentId,
    input: EngineInput,
    mode: "spawn" | "dispatch",
    options?: TaskOptions & { readonly timezone?: string | undefined },
  ): Promise<ScheduleId> {
    if (disposed) {
      throw new Error("Scheduler is disposed");
    }

    await initPromise;

    if (options?.timeoutMs !== undefined && options.timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive number");
    }

    const id = generateScheduleId();

    const cronOptions =
      options?.timezone !== undefined
        ? ({ timezone: options.timezone, paused: false } as const)
        : ({ paused: false } as const);

    const cronJob = new Cron(expression, cronOptions, () => {
      void submit(agentIdVal, input, mode, options);
    });

    crons.set(id, cronJob);

    const meta: CronSchedule = {
      id,
      expression,
      agentId: agentIdVal,
      input,
      mode,
      taskOptions: options,
      timezone: options?.timezone,
      paused: false,
    };
    cronMeta.set(id, meta);

    try {
      if (scheduleStore !== undefined) {
        await scheduleStore.saveSchedule(meta);
      }
    } catch (err: unknown) {
      // Roll back in-memory state on persistence failure
      cronJob.stop();
      crons.delete(id);
      cronMeta.delete(id);
      throw new Error("Failed to persist schedule", { cause: err });
    }

    emit({ kind: "schedule:created", schedule: meta });
    return id;
  }

  async function unschedule(id: ScheduleId): Promise<boolean> {
    const job = crons.get(id);
    if (job === undefined) return false;

    job.stop();
    crons.delete(id);
    cronMeta.delete(id);

    try {
      if (scheduleStore !== undefined) {
        await scheduleStore.removeSchedule(id);
      }
    } catch {
      // Schedule already stopped in memory — log but don't fail.
      // On restart, orphaned DB record will be re-loaded and can be removed.
    }

    emit({ kind: "schedule:removed", scheduleId: id });
    return true;
  }

  async function query(filter: TaskFilter): Promise<readonly ScheduledTask[]> {
    await initPromise;
    return store.query(filter);
  }

  function pause(id: ScheduleId): boolean {
    const job = crons.get(id as string);
    const meta = cronMeta.get(id as string);
    if (job === undefined || meta === undefined) return false;

    job.pause();
    cronMeta.set(id as string, { ...meta, paused: true });

    if (scheduleStore !== undefined) {
      // Fire-and-forget persistence — best effort
      void scheduleStore.saveSchedule({ ...meta, paused: true });
    }

    emit({ kind: "schedule:paused", scheduleId: id });
    return true;
  }

  function resume(id: ScheduleId): boolean {
    const job = crons.get(id as string);
    const meta = cronMeta.get(id as string);
    if (job === undefined || meta === undefined) return false;

    job.resume();
    cronMeta.set(id as string, { ...meta, paused: false });

    if (scheduleStore !== undefined) {
      void scheduleStore.saveSchedule({ ...meta, paused: false });
    }

    emit({ kind: "schedule:resumed", scheduleId: id });
    return true;
  }

  function stats(): SchedulerStats {
    let pausedCount = 0; // let: counted by iteration
    for (const meta of cronMeta.values()) {
      if (meta.paused) pausedCount += 1;
    }
    return {
      pending: heap.size(),
      running: config.maxConcurrent - semaphore.available(),
      completed: completedCount,
      failed: failedCount,
      deadLettered: deadLetteredCount,
      activeSchedules: crons.size,
      pausedSchedules: pausedCount,
    };
  }

  function history(_filter: TaskHistoryFilter): readonly TaskRunRecord[] {
    // In-memory scheduler does not persist run history.
    // A production implementation with a RunHistoryStore would query here.
    return [];
  }

  // P9 fix: idempotent unsubscribe, no Set copy on hot path
  function watch(listener: (event: SchedulerEvent) => void): () => void {
    listeners.add(listener);
    let removed = false; // let: set to true on first unsubscribe
    return () => {
      if (removed) return;
      removed = true;
      listeners.delete(listener);
    };
  }

  async function dispose(): Promise<void> {
    disposed = true;

    // Stop poll timer
    pollTimer.stop();

    // Stop all cron jobs
    for (const job of crons.values()) {
      job.stop();
    }
    crons.clear();
    cronMeta.clear();

    listeners.clear();
  }

  return {
    submit,
    cancel,
    schedule,
    unschedule,
    pause,
    resume,
    query,
    stats,
    history,
    watch,
    [Symbol.asyncDispose]: dispose,
  };
}
