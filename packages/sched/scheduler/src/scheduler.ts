/**
 * createScheduler — main dispatch engine.
 *
 * Responsibilities:
 * - Priority-heap dispatch with semaphore-bounded concurrency
 * - Delayed execution (scheduledAt timestamp)
 * - Exponential-backoff retries; dead-letter after maxRetries
 * - Timeout is TERMINAL — timed-out tasks go directly to dead_letter
 * - Cron scheduling via croner
 * - Crash recovery: running tasks at init are re-queued as pending
 * - Event emission via watch() listeners
 */

import type {
  AgentId,
  CronSchedule,
  EngineInput,
  KoiError,
  ScheduledTask,
  ScheduleId,
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
import { type SchedulerConfig, scheduleId, taskId } from "@koi/core";
import { Cron } from "croner";
import type { Clock } from "./clock.js";
import { SYSTEM_CLOCK } from "./clock.js";
import { createHeap } from "./heap.js";
import { computeBackoff } from "./retry.js";
import { createSemaphore } from "./semaphore.js";
import type { RunStore } from "./sqlite-store.js";
import { createPeriodicTimer } from "./timer.js";
import type { TaskDispatcher } from "./types.js";

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------

function generateTaskId(): TaskId {
  return taskId(`task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
}

function generateScheduleId(): ScheduleId {
  return scheduleId(`sched_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
}

// ---------------------------------------------------------------------------
// Heap comparator: lower priority number = higher priority; tie-break by age
// ---------------------------------------------------------------------------

function taskComparator(a: ScheduledTask, b: ScheduledTask): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.createdAt - b.createdAt;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScheduler(
  config: SchedulerConfig,
  store: TaskStore,
  dispatcher: TaskDispatcher,
  clock: Clock = SYSTEM_CLOCK,
  scheduleStore?: ScheduleStore | undefined,
  runStore?: RunStore | undefined,
): TaskScheduler {
  const heap = createHeap<ScheduledTask>(taskComparator);
  const semaphore = createSemaphore(config.maxConcurrent);
  const listeners = new Set<(event: SchedulerEvent) => void>();
  const cronJobs = new Map<ScheduleId, Cron>();
  const cronMeta = new Map<ScheduleId, CronSchedule>();

  // let: lifecycle flags and counters need mutation
  let disposed = false;
  let initDone = false;
  let completedCount = 0;
  let failedCount = 0;
  let deadLetteredCount = 0;

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  function emit(event: SchedulerEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (_e: unknown) {
        // isolate listener errors — never let them crash the scheduler
      }
    }
  }

  // -------------------------------------------------------------------------
  // Crash recovery + cron reload on init
  // -------------------------------------------------------------------------

  async function init(): Promise<void> {
    if (initDone) return;
    initDone = true;

    const tasks = await store.loadPending();
    for (const task of tasks) {
      if (task.status === "running") {
        if (task.retries < task.maxRetries) {
          const recovered: ScheduledTask = {
            ...task,
            status: "pending",
            retries: task.retries + 1,
          };
          await store.updateStatus(task.id, "pending", { retries: recovered.retries });
          heap.insert(recovered);
          emit({ kind: "task:recovered", taskId: task.id, retriesUsed: recovered.retries });
        } else {
          await store.updateStatus(task.id, "dead_letter");
          deadLetteredCount++;
          const err: KoiError = {
            code: "INTERNAL",
            message: "Max retries exceeded on crash recovery",
            retryable: false,
          };
          emit({ kind: "task:dead_letter", taskId: task.id, error: err });
        }
      } else {
        heap.insert(task);
      }
    }

    if (scheduleStore !== undefined) {
      const schedules = await scheduleStore.loadSchedules();
      for (const sched of schedules) {
        registerCron(sched);
        if (sched.paused) {
          const job = cronJobs.get(sched.id);
          if (job !== undefined) job.pause();
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cron helpers
  // -------------------------------------------------------------------------

  function registerCron(sched: CronSchedule): void {
    const cronOptions = sched.timezone !== undefined ? { timezone: sched.timezone } : undefined;
    const job = new Cron(sched.expression, cronOptions, async () => {
      await enqueueTask(sched.agentId, sched.input, sched.mode, sched.taskOptions);
    });
    cronJobs.set(sched.id, job);
    cronMeta.set(sched.id, sched);
  }

  // -------------------------------------------------------------------------
  // Enqueue a task (internal)
  // -------------------------------------------------------------------------

  async function enqueueTask(
    agentIdVal: AgentId,
    input: EngineInput,
    mode: "spawn" | "dispatch",
    options?: TaskOptions | undefined,
  ): Promise<TaskId> {
    if (disposed) throw new Error("Scheduler is disposed");
    await init();

    const now = clock.now();
    const id = generateTaskId();
    const task: ScheduledTask = {
      id,
      agentId: agentIdVal,
      input,
      mode,
      priority: options?.priority ?? config.defaultPriority,
      status: "pending",
      createdAt: now,
      retries: 0,
      maxRetries: options?.maxRetries ?? config.defaultMaxRetries,
      ...(options?.delayMs !== undefined ? { scheduledAt: now + options.delayMs } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
    };

    await store.save(task);
    heap.insert(task);
    emit({ kind: "task:submitted", task });
    poll();
    return id;
  }

  // -------------------------------------------------------------------------
  // Dispatch a single task
  // -------------------------------------------------------------------------

  async function dispatchTask(task: ScheduledTask): Promise<void> {
    const startedAt = clock.now();
    // Call synchronously (SQLite store returns void); no await to avoid an
    // extra microtask boundary before the dispatcher is invoked.
    void store.updateStatus(task.id, "running", { startedAt });
    emit({ kind: "task:started", taskId: task.id });

    const controller = new AbortController();
    // let: timeout handle needs to be cleared on both paths
    let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | undefined;

    try {
      let dispatchPromise: Promise<void> = dispatcher(
        task.agentId,
        task.input,
        task.mode,
        controller.signal,
      );

      if (task.timeoutMs !== undefined) {
        const timeoutMs = task.timeoutMs;
        const timeoutRace = new Promise<never>((_, reject) => {
          timeoutHandle = globalThis.setTimeout(() => {
            controller.abort();
            reject(new Error("Task timed out"));
          }, timeoutMs);
        });
        dispatchPromise = Promise.race([dispatchPromise, timeoutRace]);
      }

      await dispatchPromise;

      if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle);
      const completedAt = clock.now();
      await store.updateStatus(task.id, "completed", { completedAt });
      completedCount++;

      runStore?.saveRun({
        taskId: task.id,
        agentId: task.agentId,
        status: "completed",
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
        retryAttempt: task.retries,
      });

      emit({ kind: "task:completed", taskId: task.id, result: undefined });
    } catch (e: unknown) {
      if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle);

      const isTimeout = e instanceof Error && e.message === "Task timed out";
      const completedAt = clock.now();
      const koiError: KoiError = {
        code: isTimeout ? "TIMEOUT" : "EXTERNAL",
        message: e instanceof Error ? e.message : String(e),
        retryable: !isTimeout,
      };

      if (isTimeout || task.retries >= task.maxRetries) {
        await store.updateStatus(task.id, "dead_letter", { completedAt, lastError: koiError });
        deadLetteredCount++;

        runStore?.saveRun({
          taskId: task.id,
          agentId: task.agentId,
          status: "failed",
          startedAt,
          completedAt,
          durationMs: completedAt - startedAt,
          retryAttempt: task.retries,
          error: koiError.message,
        });

        emit({ kind: "task:dead_letter", taskId: task.id, error: koiError });
      } else {
        const delay = computeBackoff(task.retries, {
          baseDelayMs: config.baseRetryDelayMs,
          maxDelayMs: config.maxRetryDelayMs,
          jitterMs: config.retryJitterMs,
        });
        // Persist with future scheduledAt for store/recovery fidelity.
        const retried: ScheduledTask = {
          ...task,
          status: "pending",
          retries: task.retries + 1,
          scheduledAt: clock.now() + delay,
          lastError: koiError,
        };
        await store.save(retried);
        heap.insert(retried);
        poll();

        runStore?.saveRun({
          taskId: task.id,
          agentId: task.agentId,
          status: "failed",
          startedAt,
          completedAt,
          durationMs: completedAt - startedAt,
          retryAttempt: task.retries,
          error: koiError.message,
        });

        failedCount++;
        emit({ kind: "task:failed", taskId: task.id, error: koiError });
      }
    } finally {
      semaphore.release();
      poll();
    }
  }

  // -------------------------------------------------------------------------
  // Poll: drain heap of tasks ready to run
  // -------------------------------------------------------------------------

  function poll(): void {
    const now = clock.now();
    while (true) {
      const task = heap.peek();
      if (task === undefined) break;
      if (task.scheduledAt !== undefined && task.scheduledAt > now) break;
      if (!semaphore.tryAcquire()) break;
      heap.extractMin();
      void dispatchTask(task);
    }
  }

  // -------------------------------------------------------------------------
  // Periodic timer — start after init completes
  // -------------------------------------------------------------------------

  const timer = createPeriodicTimer(config.pollIntervalMs, poll, clock);
  void init().then(() => {
    if (!disposed) timer.start();
  });

  // -------------------------------------------------------------------------
  // Public TaskScheduler interface
  // -------------------------------------------------------------------------

  return {
    async submit(
      agentIdVal: AgentId,
      input: EngineInput,
      mode: "spawn" | "dispatch",
      options?: TaskOptions | undefined,
    ): Promise<TaskId> {
      return enqueueTask(agentIdVal, input, mode, options);
    },

    async cancel(id: TaskId): Promise<boolean> {
      const removed = heap.remove((t) => t.id === id);
      if (removed) {
        await store.remove(id);
        emit({ kind: "task:cancelled", taskId: id });
        return true;
      }
      return false;
    },

    async schedule(
      expression: string,
      agentIdVal: AgentId,
      input: EngineInput,
      mode: "spawn" | "dispatch",
      options?: TaskOptions & { readonly timezone?: string | undefined },
    ): Promise<ScheduleId> {
      // Validate before persisting — throws on invalid expression
      try {
        const validationOptions =
          options?.timezone !== undefined ? { timezone: options.timezone } : undefined;
        const testJob = new Cron(expression, validationOptions);
        testJob.stop();
      } catch (e: unknown) {
        throw new Error(`Invalid cron expression: "${expression}"`, { cause: e });
      }

      const id = generateScheduleId();
      const taskOptions: TaskOptions | undefined =
        options !== undefined
          ? {
              ...(options.priority !== undefined ? { priority: options.priority } : {}),
              ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
              ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
              ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
              ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
            }
          : undefined;

      const sched: CronSchedule = {
        id,
        expression,
        agentId: agentIdVal,
        input,
        mode,
        paused: false,
        ...(taskOptions !== undefined && Object.keys(taskOptions).length > 0
          ? { taskOptions }
          : {}),
        ...(options?.timezone !== undefined ? { timezone: options.timezone } : {}),
      };

      if (scheduleStore !== undefined) await scheduleStore.saveSchedule(sched);
      registerCron(sched);
      emit({ kind: "schedule:created", schedule: sched });
      return id;
    },

    async unschedule(id: ScheduleId): Promise<boolean> {
      const job = cronJobs.get(id);
      if (job === undefined) return false;
      job.stop();
      cronJobs.delete(id);
      cronMeta.delete(id);
      if (scheduleStore !== undefined) await scheduleStore.removeSchedule(id);
      emit({ kind: "schedule:removed", scheduleId: id });
      return true;
    },

    async pause(id: ScheduleId): Promise<boolean> {
      const job = cronJobs.get(id);
      const meta = cronMeta.get(id);
      if (job === undefined || meta === undefined) return false;
      const updated: CronSchedule = { ...meta, paused: true };
      if (scheduleStore !== undefined) await scheduleStore.saveSchedule(updated);
      cronMeta.set(id, updated);
      job.pause();
      emit({ kind: "schedule:paused", scheduleId: id });
      return true;
    },

    async resume(id: ScheduleId): Promise<boolean> {
      const job = cronJobs.get(id);
      const meta = cronMeta.get(id);
      if (job === undefined || meta === undefined) return false;
      const updated: CronSchedule = { ...meta, paused: false };
      if (scheduleStore !== undefined) await scheduleStore.saveSchedule(updated);
      cronMeta.set(id, updated);
      job.resume();
      emit({ kind: "schedule:resumed", scheduleId: id });
      return true;
    },

    async query(filter: TaskFilter): Promise<readonly ScheduledTask[]> {
      return store.query(filter);
    },

    querySchedules(agentId: AgentId): readonly CronSchedule[] {
      return [...cronMeta.values()].filter((s) => s.agentId === agentId);
    },

    stats(): SchedulerStats {
      return {
        pending: heap.size(),
        running: config.maxConcurrent - semaphore.available(),
        completed: completedCount,
        failed: failedCount,
        deadLettered: deadLetteredCount,
        activeSchedules: [...cronMeta.values()].filter((m) => !m.paused).length,
        pausedSchedules: [...cronMeta.values()].filter((m) => m.paused).length,
      };
    },

    async history(filter: TaskHistoryFilter): Promise<readonly TaskRunRecord[]> {
      if (runStore === undefined) return [];
      return runStore.queryRuns({
        agentId: filter.agentId,
        status: filter.status,
        since: filter.since,
        limit: filter.limit,
      });
    },

    watch(listener: (event: SchedulerEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async [Symbol.asyncDispose](): Promise<void> {
      disposed = true;
      await timer[Symbol.asyncDispose]();
      for (const job of cronJobs.values()) {
        job.stop();
      }
      cronJobs.clear();
      cronMeta.clear();
    },
  };
}
