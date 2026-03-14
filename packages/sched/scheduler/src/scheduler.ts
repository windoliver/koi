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
  TaskQueueBackend,
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
import { createAdaptiveTimer, createPeriodicTimer } from "./timer.js";

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
  queueBackend?: TaskQueueBackend,
  nodeId?: string,
): TaskScheduler {
  const clk = clock ?? createSystemClock();
  const localNodeId = nodeId ?? `node_${Math.random().toString(36).slice(2, 10)}`;
  const distributedMode = queueBackend?.claim !== undefined;
  let disposed = false; // let: set to true on dispose

  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------

  const heap = createMinHeap<ScheduledTask>((a, b) => {
    const pd = a.priority - b.priority;
    if (pd !== 0) return pd;
    return a.createdAt - b.createdAt;
  });

  const crons = new Map<ScheduleId, Cron>(); // scheduleId → Cron instance
  const cronMeta = new Map<ScheduleId, CronSchedule>(); // scheduleId → metadata
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
      try {
        listener(event);
      } catch (_listenerError: unknown) {
        // Isolate listener failures — one failing listener must not break others.
        // Errors are silently swallowed; listeners are responsible for their own error handling.
      }
    }
  }

  function generateTaskId(): TaskId {
    return taskId(`task_${clk.now()}_${Math.random().toString(36).slice(2, 10)}`);
  }

  function generateScheduleId(): ScheduleId {
    return scheduleId(`sched_${clk.now()}_${Math.random().toString(36).slice(2, 10)}`);
  }

  /** Save task to store and insert into local heap (atomic local enqueue). */
  async function enqueueLocally(task: ScheduledTask): Promise<void> {
    await store.save(task);
    heap.insert(task);
  }

  /**
   * Enqueue a task — delegates to queue backend if present, otherwise local heap.
   * When a backend is present, Nexus owns the priority queue (Decision 14A).
   */
  async function enqueueTask(task: ScheduledTask, idempotencyKey?: string): Promise<TaskId> {
    if (queueBackend !== undefined) {
      return queueBackend.enqueue(task, idempotencyKey);
    }
    await enqueueLocally(task);
    return task.id;
  }

  /**
   * Core task creation + enqueue logic shared by submit() and cron callbacks.
   * Validates, builds the task, enqueues (local or backend), emits, and polls.
   */
  async function createAndEnqueueTask(
    agentIdVal: AgentId,
    input: EngineInput,
    mode: "spawn" | "dispatch",
    options?: TaskOptions,
    idempotencyKey?: string,
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

    const assignedId = await enqueueTask(task, idempotencyKey);
    emit({ kind: "task:submitted", task });

    // P1 fix: immediately attempt dispatch for zero-delay tasks
    // When queue backend is present, Nexus handles dispatch — skip local poll
    if (queueBackend === undefined) {
      poll();
    }

    return assignedId;
  }

  /**
   * Cron tick wrapper — in distributed mode, claims the tick before enqueuing
   * so only one node fires per schedule interval.
   */
  async function cronTick(
    sid: ScheduleId,
    agentIdVal: AgentId,
    input: EngineInput,
    mode: "spawn" | "dispatch",
    options?: TaskOptions,
    idempotencyKey?: string,
  ): Promise<void> {
    if (distributedMode && queueBackend?.tick !== undefined) {
      const claimed = await queueBackend.tick(sid, localNodeId);
      if (!claimed) return; // Another node won this tick
    }
    await createAndEnqueueTask(agentIdVal, input, mode, options, idempotencyKey);
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

        // In distributed mode, ack the task on the backend
        if (distributedMode) {
          await queueBackend?.ack?.(task.id, result);
        }
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
          if (distributedMode) {
            // Distributed mode: compute backoff delay and persist retry state
            // before nacking so the server-side re-queue respects the delay.
            // The nack interface does not accept a delay parameter, so we
            // advance retries + scheduledAt in the local store.
            const delay = computeRetryDelay(task.retries, config);
            await store.updateStatus(task.id, "pending", {
              retries: nextRetries,
            });
            // Update scheduledAt via save so re-claim respects backoff
            const retask: ScheduledTask = {
              ...task,
              status: "pending",
              retries: nextRetries,
              scheduledAt: clk.now() + delay,
              lastError: koiError,
            };
            await store.save(retask);
            await queueBackend?.nack?.(task.id, koiError.message);
          } else {
            // Local mode: re-queue with backoff
            const delay = computeRetryDelay(task.retries, config);
            const retask: ScheduledTask = {
              ...task,
              status: "pending",
              retries: nextRetries,
              scheduledAt: clk.now() + delay,
              lastError: koiError,
            };
            await enqueueLocally(retask);
          }
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

          // In distributed mode, nack with dead-letter reason
          if (distributedMode) {
            await queueBackend?.nack?.(task.id, `dead_letter: ${koiError.message}`);
          }
        }
      }
    } catch (_infraError: unknown) {
      // Infrastructure failure (store error) — re-insert for retry on next poll
      if (!distributedMode) {
        heap.insert(task);
      }
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
    const deferred: ScheduledTask[] = []; // delayed tasks to re-insert after loop
    while (true) {
      const next = heap.peek();
      if (next === undefined) break;

      // Skip tasks scheduled for the future — pop and stash for re-insertion
      if (next.scheduledAt !== undefined && next.scheduledAt > now) {
        const skipped = heap.extractMin();
        if (skipped !== undefined) {
          deferred.push(skipped);
        }
        continue;
      }

      if (!semaphore.acquire()) break;

      const task = heap.extractMin();
      if (task === undefined) {
        semaphore.release();
        break;
      }
      // Fire and forget — errors handled inside dispatchTask
      void dispatchTask(task);
    }

    // Re-insert deferred tasks so they are dispatched on a future poll cycle
    for (const task of deferred) {
      heap.insert(task);
    }
  }

  // ---------------------------------------------------------------------------
  // Distributed poll loop — claims tasks from the backend
  // ---------------------------------------------------------------------------

  let consecutiveEmpty = 0; // let: tracks empty claim results for adaptive backoff

  async function distributedPoll(): Promise<void> {
    if (disposed) return;

    const availableSlots = semaphore.available();
    if (availableSlots <= 0) return;

    try {
      const claimed = (await queueBackend?.claim?.(localNodeId, availableSlots)) ?? [];

      if (claimed.length === 0) {
        consecutiveEmpty += 1;
        return;
      }

      // Reset backoff on successful claim
      consecutiveEmpty = 0;

      for (const task of claimed) {
        if (!semaphore.acquire()) break;

        // Save task locally for status tracking, then dispatch.
        // If save fails, release the semaphore slot acquired above —
        // dispatchTask (which owns the final release) never executes.
        try {
          await store.save(task);
        } catch (saveError: unknown) {
          semaphore.release();
          await queueBackend?.nack?.(
            task.id,
            saveError instanceof Error ? saveError.message : String(saveError),
          );
          continue;
        }
        void dispatchTask(task);
      }
    } catch (_claimError: unknown) {
      // Claim failure — backoff will handle next attempt
      consecutiveEmpty += 1;
    }
  }

  function computeAdaptiveInterval(): number {
    if (consecutiveEmpty === 0) return config.pollIntervalMs;
    return Math.min(
      config.maxRetryDelayMs,
      config.pollIntervalMs * 2 ** Math.min(consecutiveEmpty, 10),
    );
  }

  // In distributed mode, use adaptive polling; otherwise use fixed-interval local poll
  const pollTimer = distributedMode
    ? createAdaptiveTimer(clk, () => computeAdaptiveInterval(), distributedPoll)
    : createPeriodicTimer(clk, config.pollIntervalMs, poll);

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
        heap.remove((t) => t.id === task.id); // Remove stale version if present
        await enqueueLocally(recovered);
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
          const idempotencyKey = `${meta.id}:${String(clk.now())}`;
          void cronTick(
            meta.id,
            meta.agentId,
            meta.input,
            meta.mode,
            meta.taskOptions,
            idempotencyKey,
          );
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
    return createAndEnqueueTask(agentIdVal, input, mode, options);
  }

  async function cancel(id: TaskId): Promise<boolean> {
    if (disposed) return false;

    await initPromise;

    if (queueBackend !== undefined) {
      const cancelled = await queueBackend.cancel(id);
      if (cancelled) {
        emit({ kind: "task:cancelled", taskId: id });
      }
      return cancelled;
    }

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
      const idempotencyKey = `${id}:${String(clk.now())}`;
      void cronTick(id, agentIdVal, input, mode, options, idempotencyKey);
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

  function updateCronState(id: ScheduleId, paused: boolean): boolean {
    const job = crons.get(id);
    const meta = cronMeta.get(id);
    if (job === undefined || meta === undefined) return false;

    if (paused) {
      job.pause();
    } else {
      job.resume();
    }
    cronMeta.set(id, { ...meta, paused });

    if (scheduleStore !== undefined) {
      // Fire-and-forget persistence — best effort
      void scheduleStore.saveSchedule({ ...meta, paused });
    }

    emit({ kind: paused ? "schedule:paused" : "schedule:resumed", scheduleId: id });
    return true;
  }

  function pause(id: ScheduleId): boolean {
    return updateCronState(id, true);
  }

  function resume(id: ScheduleId): boolean {
    return updateCronState(id, false);
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

    if (queueBackend !== undefined) {
      await queueBackend[Symbol.asyncDispose]();
    }
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
