import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { EngineInput, SchedulerConfig, SchedulerEvent } from "@koi/core";
import { agentId, DEFAULT_SCHEDULER_CONFIG, taskId } from "@koi/core";
import { createFakeClock } from "../clock.js";
import type { TaskDispatcher } from "../scheduler.js";
import { createScheduler } from "../scheduler.js";
import { createSqliteTaskStore } from "../sqlite-store.js";

const TEXT_INPUT: EngineInput = { kind: "text", text: "hello" };

function setup(overrides?: Partial<SchedulerConfig>): {
  readonly clock: ReturnType<typeof createFakeClock>;
  readonly db: Database;
  readonly store: ReturnType<typeof createSqliteTaskStore>;
  readonly dispatcher: ReturnType<typeof mock<TaskDispatcher>>;
  readonly config: SchedulerConfig;
  readonly scheduler: ReturnType<typeof createScheduler>;
} {
  const clock = createFakeClock(1000);
  const db = new Database(":memory:");
  const store = createSqliteTaskStore(db);
  const dispatcher = mock<TaskDispatcher>(() => Promise.resolve("ok"));
  const config: SchedulerConfig = {
    ...DEFAULT_SCHEDULER_CONFIG,
    pollIntervalMs: 100,
    ...overrides,
  };
  const scheduler = createScheduler(config, store, dispatcher, clock);

  return { clock, db, store, dispatcher, config, scheduler } as const;
}

describe("TaskScheduler", () => {
  let teardown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (teardown !== undefined) {
      await teardown();
      teardown = undefined;
    }
  });

  test("submit returns a TaskId", async () => {
    const { scheduler } = setup();
    teardown = async () => scheduler[Symbol.asyncDispose]();

    const id = await scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn");
    expect(typeof id).toBe("string");
    expect(id).toContain("task_");
  });

  test("delayed task appears in pending query", async () => {
    const { scheduler } = setup();
    teardown = async () => scheduler[Symbol.asyncDispose]();

    const id = await scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn", { delayMs: 5000 });

    const tasks = await scheduler.query({ status: "pending" });
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.some((t) => t.id === id)).toBe(true);
  });

  test("submit with no delay dispatches immediately", async () => {
    const { scheduler, dispatcher } = setup();
    teardown = async () => scheduler[Symbol.asyncDispose]();

    await scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn");

    // Immediate poll dispatches; allow microtasks to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(dispatcher.mock.calls[0]?.[0]).toBe(agentId("a1"));
  });

  test("priority ordering: higher priority dispatched first", async () => {
    const callOrder: string[] = [];
    const orderedDispatcher = mock<TaskDispatcher>(async (aid) => {
      callOrder.push(aid);
      return "ok";
    });

    const clock = createFakeClock(1000);
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);

    // Use maxConcurrent=1 so only one dispatches at a time during poll
    const config: SchedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      pollIntervalMs: 100,
      maxConcurrent: 1,
    };
    const scheduler = createScheduler(config, store, orderedDispatcher, clock);
    teardown = async () => scheduler[Symbol.asyncDispose]();

    // Submit both with delay so they queue up without dispatching
    await scheduler.submit(agentId("low"), TEXT_INPUT, "spawn", { priority: 10, delayMs: 200 });
    await scheduler.submit(agentId("high"), TEXT_INPUT, "spawn", { priority: 1, delayMs: 200 });

    // Advance past delay + poll interval to dispatch
    clock.tick(350);
    await new Promise((r) => setTimeout(r, 20));

    // First dispatch completes, releasing semaphore for second
    clock.tick(150);
    await new Promise((r) => setTimeout(r, 20));

    // High priority should be dispatched first
    expect(callOrder[0]).toBe("high");
    expect(callOrder[1]).toBe("low");
  });

  test("cancel delayed task before execution prevents dispatch", async () => {
    const { scheduler, clock, dispatcher } = setup();
    teardown = async () => scheduler[Symbol.asyncDispose]();

    // Use delay so the task sits in the heap
    const id = await scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn", { delayMs: 5000 });
    const cancelled = await scheduler.cancel(id);
    expect(cancelled).toBe(true);

    clock.tick(6000);
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatcher).toHaveBeenCalledTimes(0);
  });

  test("retry on failure re-queues with backoff", async () => {
    let callCount = 0; // let: incremented on each dispatch call
    const failDispatcher = mock<TaskDispatcher>(async () => {
      callCount += 1;
      if (callCount <= 2) {
        throw new Error("fail");
      }
      return "ok";
    });

    const clock = createFakeClock(1000);
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const config: SchedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      pollIntervalMs: 100,
      baseRetryDelayMs: 100,
      maxRetryDelayMs: 1000,
      retryJitterMs: 0,
    };
    const scheduler = createScheduler(config, store, failDispatcher, clock);
    teardown = async () => scheduler[Symbol.asyncDispose]();

    await scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn", { maxRetries: 3 });

    // First dispatch happens immediately via poll() in submit()
    await new Promise((r) => setTimeout(r, 10));
    expect(callCount).toBe(1);

    // Retry after backoff: 100ms * 2^0 = 100ms
    clock.tick(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(callCount).toBe(2);

    // Retry after backoff: 100ms * 2^1 = 200ms
    clock.tick(300);
    await new Promise((r) => setTimeout(r, 10));
    expect(callCount).toBe(3);
  });

  test("dead letter after maxRetries exhausted", async () => {
    const events: SchedulerEvent[] = [];
    const failDispatcher = mock<TaskDispatcher>(async () => {
      throw new Error("always fails");
    });

    const clock = createFakeClock(1000);
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const config: SchedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      pollIntervalMs: 100,
      baseRetryDelayMs: 50,
      maxRetryDelayMs: 200,
      retryJitterMs: 0,
    };
    const scheduler = createScheduler(config, store, failDispatcher, clock);
    teardown = async () => scheduler[Symbol.asyncDispose]();
    scheduler.watch((e) => events.push(e));

    await scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn", { maxRetries: 1 });

    // Immediate dispatch (fails, retries exhausted with maxRetries=1)
    await new Promise((r) => setTimeout(r, 10));

    const deadLetterEvents = events.filter((e) => e.kind === "task:dead_letter");
    expect(deadLetterEvents.length).toBe(1);
  });

  test("concurrency bounded by maxConcurrent", async () => {
    let concurrent = 0; // let: tracks concurrent dispatches
    let maxConcurrentSeen = 0; // let: tracks peak concurrency

    const slowDispatcher = mock<TaskDispatcher>(async () => {
      concurrent += 1;
      maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrent);
      await new Promise((r) => setTimeout(r, 50));
      concurrent -= 1;
      return "ok";
    });

    const clock = createFakeClock(1000);
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const config: SchedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      pollIntervalMs: 100,
      maxConcurrent: 2,
    };
    const scheduler = createScheduler(config, store, slowDispatcher, clock);
    teardown = async () => scheduler[Symbol.asyncDispose]();

    // Submit 5 tasks
    for (let i = 0; i < 5; i++) {
      await scheduler.submit(agentId(`a${String(i)}`), TEXT_INPUT, "spawn");
    }

    await new Promise((r) => setTimeout(r, 20));

    // Should not exceed maxConcurrent
    expect(maxConcurrentSeen).toBeLessThanOrEqual(2);
  });

  test("stats reflect current state", async () => {
    const { scheduler } = setup();
    teardown = async () => scheduler[Symbol.asyncDispose]();

    const initial = scheduler.stats();
    expect(initial.pending).toBe(0);
    expect(initial.running).toBe(0);
    expect(initial.completed).toBe(0);
    expect(initial.activeSchedules).toBe(0);

    // Delayed task stays pending in the heap
    await scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn", { delayMs: 5000 });
    const afterSubmit = scheduler.stats();
    expect(afterSubmit.pending).toBe(1);
  });

  test("watch receives events in order", async () => {
    const events: SchedulerEvent[] = [];
    const { scheduler } = setup();
    teardown = async () => scheduler[Symbol.asyncDispose]();

    scheduler.watch((e) => events.push(e));

    await scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn");
    // Immediate poll dispatches; allow microtasks to resolve
    await new Promise((r) => setTimeout(r, 10));

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("task:submitted");
    expect(kinds).toContain("task:started");
    expect(kinds).toContain("task:completed");

    // Verify order: submitted before started before completed
    const submittedIdx = kinds.indexOf("task:submitted");
    const startedIdx = kinds.indexOf("task:started");
    const completedIdx = kinds.indexOf("task:completed");
    expect(submittedIdx).toBeLessThan(startedIdx);
    expect(startedIdx).toBeLessThan(completedIdx);
  });

  test("delayed task not dispatched until scheduledAt", async () => {
    const { scheduler, clock, dispatcher } = setup();
    teardown = async () => scheduler[Symbol.asyncDispose]();

    await scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn", { delayMs: 500 });

    // Immediate poll skips delayed task
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatcher).toHaveBeenCalledTimes(0);

    // Advance past delay
    clock.tick(600);
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  test("dispose stops all processing", async () => {
    const { scheduler, clock, dispatcher } = setup();

    await scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn", { delayMs: 5000 });
    await scheduler[Symbol.asyncDispose]();

    clock.tick(6000);
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatcher).toHaveBeenCalledTimes(0);
  });

  test("submit after dispose throws", async () => {
    const { scheduler } = setup();
    await scheduler[Symbol.asyncDispose]();

    expect(scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn")).rejects.toThrow(
      "Scheduler is disposed",
    );
  });

  test("unwatch stops event delivery", async () => {
    const events: SchedulerEvent[] = [];
    const { scheduler } = setup();
    teardown = async () => scheduler[Symbol.asyncDispose]();

    const unwatch = scheduler.watch((e) => events.push(e));
    // Use delayed task so poll() in submit doesn't dispatch
    await scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn", { delayMs: 5000 });
    unwatch();

    // Should only have the submitted event (before unwatch)
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("task:submitted");
  });

  test("cancel returns false for non-existent task", async () => {
    const { scheduler } = setup();
    teardown = async () => scheduler[Symbol.asyncDispose]();

    const result = await scheduler.cancel(taskId("nonexistent"));
    expect(result).toBe(false);
  });

  // Gap 1: timeoutMs enforcement
  test("timeout fires when dispatcher exceeds timeoutMs", async () => {
    const events: SchedulerEvent[] = [];
    const slowDispatcher = mock<TaskDispatcher>(async () => {
      // Simulate slow work — will be interrupted by fake clock timeout
      await new Promise((r) => setTimeout(r, 5000));
      return "ok";
    });

    const clock = createFakeClock(1000);
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const config: SchedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      pollIntervalMs: 100,
    };
    const scheduler = createScheduler(config, store, slowDispatcher, clock);
    teardown = async () => scheduler[Symbol.asyncDispose]();
    scheduler.watch((e) => events.push(e));

    await scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn", {
      timeoutMs: 200,
      maxRetries: 1,
    });

    // Let submit's immediate poll fire the dispatcher
    await new Promise((r) => setTimeout(r, 10));

    // Advance clock past timeout to trigger it
    clock.tick(300);
    await new Promise((r) => setTimeout(r, 10));

    const deadLetters = events.filter((e) => e.kind === "task:dead_letter");
    expect(deadLetters.length).toBe(1);
    expect((deadLetters[0] as { readonly error: { readonly code: string } }).error.code).toBe(
      "TIMEOUT",
    );
  });

  test("timeout + retry increments retries", async () => {
    const events: SchedulerEvent[] = [];
    const slowDispatcher = mock<TaskDispatcher>(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return "ok";
    });

    const clock = createFakeClock(1000);
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const config: SchedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      pollIntervalMs: 100,
      baseRetryDelayMs: 50,
      maxRetryDelayMs: 200,
      retryJitterMs: 0,
    };
    const scheduler = createScheduler(config, store, slowDispatcher, clock);
    teardown = async () => scheduler[Symbol.asyncDispose]();
    scheduler.watch((e) => events.push(e));

    await scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn", {
      timeoutMs: 100,
      maxRetries: 3,
    });

    await new Promise((r) => setTimeout(r, 10));

    // Trigger first timeout
    clock.tick(150);
    await new Promise((r) => setTimeout(r, 10));

    const failedEvents = events.filter((e) => e.kind === "task:failed");
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("no timeout when timeoutMs is omitted", async () => {
    const { scheduler, dispatcher } = setup();
    teardown = async () => scheduler[Symbol.asyncDispose]();

    await scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn");

    // Allow dispatch
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  test("submit rejects timeoutMs <= 0", async () => {
    const { scheduler } = setup();
    teardown = async () => scheduler[Symbol.asyncDispose]();

    expect(scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn", { timeoutMs: 0 })).rejects.toThrow(
      "timeoutMs must be a positive number",
    );

    expect(
      scheduler.submit(agentId("a1"), TEXT_INPUT, "spawn", { timeoutMs: -100 }),
    ).rejects.toThrow("timeoutMs must be a positive number");
  });

  // Gap 2: stale task recovery
  test("stale running task recovered on initialize", async () => {
    const events: SchedulerEvent[] = [];
    const clock = createFakeClock(500_000);
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);

    // Pre-seed a stale running task (startedAt is old enough)
    await store.save({
      id: taskId("stale_1"),
      agentId: agentId("a1"),
      input: TEXT_INPUT,
      mode: "spawn",
      priority: 5,
      status: "running",
      createdAt: 1000,
      startedAt: 1000, // 499s ago with clock at 500_000
      retries: 0,
      maxRetries: 3,
    });

    const dispatcher = mock<TaskDispatcher>(() => Promise.resolve("ok"));
    const config: SchedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      pollIntervalMs: 100,
      staleTaskThresholdMs: 300_000, // 5 min
    };
    const scheduler = createScheduler(config, store, dispatcher, clock);
    teardown = async () => scheduler[Symbol.asyncDispose]();
    scheduler.watch((e) => events.push(e));

    // Wait for init to complete
    await new Promise((r) => setTimeout(r, 50));

    const recovered = events.filter((e) => e.kind === "task:recovered");
    expect(recovered.length).toBe(1);
    expect(
      (recovered[0] as { readonly taskId: string; readonly retriesUsed: number }).retriesUsed,
    ).toBe(1);
  });

  test("stale running task dead-lettered when retries exhausted", async () => {
    const events: SchedulerEvent[] = [];
    const clock = createFakeClock(500_000);
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);

    // Pre-seed stale task at max retries
    await store.save({
      id: taskId("stale_2"),
      agentId: agentId("a1"),
      input: TEXT_INPUT,
      mode: "spawn",
      priority: 5,
      status: "running",
      createdAt: 1000,
      startedAt: 1000,
      retries: 2,
      maxRetries: 3,
    });

    const dispatcher = mock<TaskDispatcher>(() => Promise.resolve("ok"));
    const config: SchedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      pollIntervalMs: 100,
      staleTaskThresholdMs: 300_000,
    };
    const scheduler = createScheduler(config, store, dispatcher, clock);
    teardown = async () => scheduler[Symbol.asyncDispose]();
    scheduler.watch((e) => events.push(e));

    await new Promise((r) => setTimeout(r, 50));

    const deadLetters = events.filter((e) => e.kind === "task:dead_letter");
    expect(deadLetters.length).toBe(1);
  });

  test("non-stale running task is not recovered", async () => {
    const events: SchedulerEvent[] = [];
    const clock = createFakeClock(2000);
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);

    // Task started 1s ago — well within staleTaskThresholdMs
    await store.save({
      id: taskId("fresh_1"),
      agentId: agentId("a1"),
      input: TEXT_INPUT,
      mode: "spawn",
      priority: 5,
      status: "running",
      createdAt: 1000,
      startedAt: 1000,
      retries: 0,
      maxRetries: 3,
    });

    const dispatcher = mock<TaskDispatcher>(() => Promise.resolve("ok"));
    const config: SchedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      pollIntervalMs: 100,
      staleTaskThresholdMs: 300_000,
    };
    const scheduler = createScheduler(config, store, dispatcher, clock);
    teardown = async () => scheduler[Symbol.asyncDispose]();
    scheduler.watch((e) => events.push(e));

    await new Promise((r) => setTimeout(r, 50));

    const recovered = events.filter((e) => e.kind === "task:recovered");
    expect(recovered.length).toBe(0);
  });
});
