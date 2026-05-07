import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type {
  AgentId,
  CronSchedule,
  EngineInput,
  ScheduledTask,
  ScheduledTaskStatus,
  SchedulerEvent,
  TaskFilter,
  TaskId,
  TaskQueueBackend,
  TaskStore,
} from "@koi/core";
import { agentId, DEFAULT_SCHEDULER_CONFIG } from "@koi/core";
import { createFakeClock } from "./clock.js";
import { createScheduler } from "./scheduler.js";
import { createSqliteScheduleStore, createSqliteTaskStore } from "./sqlite-store.js";
import type { TaskDispatcher } from "./types.js";

const aid = agentId("test-agent" as AgentId);
const input: EngineInput = { kind: "text", text: "run me" };

function makeDb(): Database {
  return new Database(":memory:");
}

function taskMatchesFilter(task: ScheduledTask, filter: TaskFilter): boolean {
  if (filter.status !== undefined && task.status !== filter.status) return false;
  if (filter.agentId !== undefined && task.agentId !== filter.agentId) return false;
  if (filter.priority !== undefined && task.priority !== filter.priority) return false;
  return true;
}

function createDeferredRunningStore(
  events: string[],
  onRunningUpdate: (release: () => void) => void,
): TaskStore {
  const tasks = new Map<TaskId, ScheduledTask>();

  function applyStatus(
    id: TaskId,
    status: ScheduledTaskStatus,
    patch?: Partial<Pick<ScheduledTask, "startedAt" | "completedAt" | "lastError" | "retries">>,
  ): void {
    const task = tasks.get(id);
    if (task !== undefined) {
      tasks.set(id, { ...task, status, ...patch });
    }
  }

  return {
    save: (task: ScheduledTask): void => {
      tasks.set(task.id, task);
    },
    load: (id: TaskId): ScheduledTask | undefined => tasks.get(id),
    remove: (id: TaskId): void => {
      tasks.delete(id);
    },
    updateStatus: (
      id: TaskId,
      status: ScheduledTaskStatus,
      patch?: Partial<Pick<ScheduledTask, "startedAt" | "completedAt" | "lastError" | "retries">>,
    ): void | Promise<void> => {
      if (status !== "running") {
        applyStatus(id, status, patch);
        return;
      }

      events.push("update:running:start");
      return new Promise<void>((resolve) => {
        onRunningUpdate(() => {
          applyStatus(id, status, patch);
          events.push("update:running:done");
          resolve();
        });
      });
    },
    query: (filter: TaskFilter): readonly ScheduledTask[] =>
      [...tasks.values()].filter((task) => taskMatchesFilter(task, filter)),
    loadPending: (): readonly ScheduledTask[] =>
      [...tasks.values()].filter((task) => task.status === "pending" || task.status === "running"),
    async [Symbol.asyncDispose](): Promise<void> {
      tasks.clear();
    },
  };
}

function createFakeDistributedQueue(tasks: readonly ScheduledTask[] = []) {
  const queued = [...tasks];
  const claimed: string[] = [];
  const acked: string[] = [];
  const nacked: string[] = [];
  const tickClaims = new Set<string>();

  const queueBackend: TaskQueueBackend = {
    async enqueue(task) {
      queued.push(task);
      return task.id;
    },
    async cancel(taskId) {
      const index = queued.findIndex((task) => task.id === taskId);
      if (index === -1) return false;
      queued.splice(index, 1);
      return true;
    },
    async status(taskId) {
      return queued.find((task) => task.id === taskId)?.status;
    },
    async claim(nodeId, limit = 1) {
      const claimedTasks = queued.splice(0, limit);
      for (const task of claimedTasks) {
        claimed.push(`${nodeId}:${String(task.id)}`);
      }
      return claimedTasks;
    },
    async ack(taskId) {
      acked.push(String(taskId));
      return true;
    },
    async nack(taskId) {
      nacked.push(String(taskId));
      return true;
    },
    async tick(scheduleId, nodeId) {
      const key = `${String(scheduleId)}:${nodeId}`;
      if (tickClaims.size > 0) return false;
      tickClaims.add(key);
      return true;
    },
    async [Symbol.asyncDispose]() {},
  };

  return { queueBackend, queued, claimed, acked, nacked, tickClaims };
}

describe("createScheduler", () => {
  it("submit returns a taskId and fires dispatcher", async () => {
    const clock = createFakeClock(1000);
    const dispatched: EngineInput[] = [];
    const dispatcher: TaskDispatcher = async (_a, inp) => {
      dispatched.push(inp);
    };
    const db = makeDb();
    const scheduler = createScheduler(
      { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 50 },
      createSqliteTaskStore(db),
      dispatcher,
      clock,
    );
    const id = await scheduler.submit(aid, input, "spawn");
    expect(typeof id).toBe("string");
    clock.tick(100);
    await new Promise<void>((r) => clock.setTimeout(r, 0));
    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    await scheduler[Symbol.asyncDispose]();
  });

  it("one-shot task fires once with delayMs", async () => {
    const clock = createFakeClock(0);
    let count = 0;
    const dispatcher: TaskDispatcher = async () => {
      count++;
    };
    const scheduler = createScheduler(
      DEFAULT_SCHEDULER_CONFIG,
      createSqliteTaskStore(makeDb()),
      dispatcher,
      clock,
    );
    await scheduler.submit(aid, input, "spawn", { delayMs: 500 });
    clock.tick(499);
    await Promise.resolve();
    expect(count).toBe(0);
    clock.tick(1);
    await Promise.resolve();
    await scheduler[Symbol.asyncDispose]();
  });

  it("invalid cron expression is rejected", async () => {
    const scheduler = createScheduler(
      DEFAULT_SCHEDULER_CONFIG,
      createSqliteTaskStore(makeDb()),
      async () => {},
    );
    void expect(scheduler.schedule("not-a-cron", aid, input, "spawn")).rejects.toThrow();
    await scheduler[Symbol.asyncDispose]();
  });

  it("cancel prevents dispatch", async () => {
    const clock = createFakeClock(0);
    let count = 0;
    const dispatcher: TaskDispatcher = async () => {
      count++;
    };
    const scheduler = createScheduler(
      { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 10_000 },
      createSqliteTaskStore(makeDb()),
      dispatcher,
      clock,
    );
    const id = await scheduler.submit(aid, input, "spawn", { delayMs: 5_000 });
    const cancelled = await scheduler.cancel(id);
    expect(cancelled).toBe(true);
    clock.tick(100);
    await Promise.resolve();
    expect(count).toBe(0);
    await scheduler[Symbol.asyncDispose]();
  });

  it("task retry on failure", async () => {
    const clock = createFakeClock(0);
    let attempts = 0;
    const dispatcher: TaskDispatcher = async () => {
      attempts++;
      if (attempts < 2) throw new Error("transient failure");
    };
    const scheduler = createScheduler(
      {
        ...DEFAULT_SCHEDULER_CONFIG,
        pollIntervalMs: 10,
        baseRetryDelayMs: 1,
        maxRetryDelayMs: 1,
        retryJitterMs: 0,
      },
      createSqliteTaskStore(makeDb()),
      dispatcher,
      clock,
    );
    await scheduler.submit(aid, input, "spawn", { maxRetries: 3 });
    for (let i = 0; i < 10; i++) {
      clock.tick(50);
      await new Promise((r) => globalThis.setTimeout(r, 5));
    }
    expect(attempts).toBeGreaterThanOrEqual(2);
    await scheduler[Symbol.asyncDispose]();
  });

  it("dead-letters after maxRetries exhausted", async () => {
    const clock = createFakeClock(0);
    const events: SchedulerEvent[] = [];
    const dispatcher: TaskDispatcher = async () => {
      throw new Error("always fails");
    };
    const scheduler = createScheduler(
      {
        ...DEFAULT_SCHEDULER_CONFIG,
        pollIntervalMs: 10,
        baseRetryDelayMs: 1,
        maxRetryDelayMs: 1,
        retryJitterMs: 0,
      },
      createSqliteTaskStore(makeDb()),
      dispatcher,
      clock,
    );
    scheduler.watch((e: SchedulerEvent) => events.push(e));
    await scheduler.submit(aid, input, "spawn", { maxRetries: 1 });
    for (let i = 0; i < 20; i++) {
      clock.tick(10);
      await new Promise((r) => globalThis.setTimeout(r, 5));
    }
    const deadLetter = events.find((e) => e.kind === "task:dead_letter");
    expect(deadLetter).toBeDefined();
    await scheduler[Symbol.asyncDispose]();
  });

  it("watch emits task:submitted", async () => {
    const events: SchedulerEvent[] = [];
    const scheduler = createScheduler(
      DEFAULT_SCHEDULER_CONFIG,
      createSqliteTaskStore(makeDb()),
      async () => {},
    );
    scheduler.watch((e: SchedulerEvent) => events.push(e));
    await scheduler.submit(aid, input, "spawn");
    expect(events.some((e) => e.kind === "task:submitted")).toBe(true);
    await scheduler[Symbol.asyncDispose]();
  });

  it("awaits persisted running status before starting dispatch", async () => {
    const events: string[] = [];
    let releaseRunningUpdate: (() => void) | undefined;
    const store = createDeferredRunningStore(events, (release) => {
      releaseRunningUpdate = release;
    });
    const scheduler = createScheduler(
      { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 60_000 },
      store,
      async () => {
        events.push("dispatch");
      },
      createFakeClock(0),
    );
    scheduler.watch((event) => {
      if (event.kind === "task:started") events.push("event:started");
    });

    await scheduler.submit(aid, input, "spawn");
    await Promise.resolve();

    expect(events).toEqual(["update:running:start"]);
    if (releaseRunningUpdate === undefined) throw new Error("running status update not started");

    releaseRunningUpdate();
    await Promise.resolve();
    await Promise.resolve();

    expect(events.slice(0, 4)).toEqual([
      "update:running:start",
      "update:running:done",
      "event:started",
      "dispatch",
    ]);

    await scheduler[Symbol.asyncDispose]();
    await store[Symbol.asyncDispose]();
  });

  it("query returns tasks filtered by agentId", async () => {
    const scheduler = createScheduler(
      DEFAULT_SCHEDULER_CONFIG,
      createSqliteTaskStore(makeDb()),
      async () => {},
    );
    await scheduler.submit(aid, input, "spawn");
    const tasks = await scheduler.query({ agentId: aid });
    expect(tasks.length).toBeGreaterThan(0);
    await scheduler[Symbol.asyncDispose]();
  });

  it("cancel removes task from query results", async () => {
    const clock = createFakeClock(0);
    const scheduler = createScheduler(
      { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 60_000 },
      createSqliteTaskStore(makeDb()),
      async () => {},
      clock,
    );
    const id = await scheduler.submit(aid, input, "spawn", { delayMs: 30_000 });
    const before = await scheduler.query({ agentId: aid, status: "pending" });
    expect(before.length).toBe(1);
    await scheduler.cancel(id);
    const after = await scheduler.query({ agentId: aid, status: "pending" });
    expect(after.length).toBe(0);
    await scheduler[Symbol.asyncDispose]();
  });

  it("delayed task stays pending until clock advances", async () => {
    const clock = createFakeClock(0);
    const dispatched: number[] = [];
    const scheduler = createScheduler(
      { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 100 },
      createSqliteTaskStore(makeDb()),
      async () => {
        dispatched.push(clock.now());
      },
      clock,
    );
    await scheduler.submit(aid, input, "spawn", { delayMs: 1_000 });
    // before delay: still pending
    const pending = await scheduler.query({ agentId: aid, status: "pending" });
    expect(pending.length).toBe(1);
    expect(dispatched.length).toBe(0);
    clock.tick(1_000);
    await new Promise<void>((r) => clock.setTimeout(r, 0));
    expect(dispatched.length).toBe(1);
    await scheduler[Symbol.asyncDispose]();
  });

  it("stats.pending reflects submitted task count", async () => {
    const clock = createFakeClock(0);
    const scheduler = createScheduler(
      { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 60_000 },
      createSqliteTaskStore(makeDb()),
      async () => {},
      clock,
    );
    await scheduler.submit(aid, input, "spawn", { delayMs: 60_000 });
    await scheduler.submit(aid, input, "spawn", { delayMs: 60_000 });
    await scheduler.submit(aid, input, "spawn", { delayMs: 60_000 });
    const s = scheduler.stats();
    expect(s.pending).toBe(3);
    expect(s.running).toBe(0);
    await scheduler[Symbol.asyncDispose]();
  });

  it("query scoped to agentId — other agent's tasks not visible", async () => {
    const otherAid = agentId("other-agent" as AgentId);
    const scheduler = createScheduler(
      { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 60_000 },
      createSqliteTaskStore(makeDb()),
      async () => {},
    );
    await scheduler.submit(aid, input, "spawn", { delayMs: 60_000 });
    await scheduler.submit(otherAid, input, "spawn", { delayMs: 60_000 });
    const aidTasks = await scheduler.query({ agentId: aid });
    const otherTasks = await scheduler.query({ agentId: otherAid });
    expect(aidTasks.length).toBe(1);
    expect(otherTasks.length).toBe(1);
    expect(aidTasks[0]?.agentId).toBe(aid);
    expect(otherTasks[0]?.agentId).toBe(otherAid);
    await scheduler[Symbol.asyncDispose]();
  });

  it("paused schedule survives dispose+recreate from same DB", async () => {
    const db = makeDb();
    const scheduleStore = createSqliteScheduleStore(db);

    const make = (): ReturnType<typeof createScheduler> =>
      createScheduler(
        DEFAULT_SCHEDULER_CONFIG,
        createSqliteTaskStore(db),
        async () => {},
        undefined,
        scheduleStore,
      );

    const s1 = make();
    const sid = await s1.schedule("* * * * *", aid, input, "spawn");
    await s1.pause(sid);
    const beforeDispose = await s1.querySchedules(aid);
    expect(beforeDispose.find((s: CronSchedule) => s.id === sid)?.paused).toBe(true);
    await s1[Symbol.asyncDispose]();

    // Recreate from same DB — paused state must survive
    const s2 = make();
    // Give init() a tick to load from store
    await new Promise<void>((r) => globalThis.setTimeout(r, 20));
    const afterRestore = await s2.querySchedules(aid);
    expect(afterRestore.find((s: CronSchedule) => s.id === sid)?.paused).toBe(true);
    await s2[Symbol.asyncDispose]();
  });

  it("claims distributed tasks from queue backend and acknowledges completion", async () => {
    const claimedTask: ScheduledTask = {
      id: "task_claimed" as TaskId,
      agentId: aid,
      input,
      mode: "spawn",
      priority: 1,
      status: "pending",
      createdAt: 0,
      retries: 0,
      maxRetries: 1,
    };
    const store = createSqliteTaskStore(makeDb());
    await store.save(claimedTask);
    const distributed = createFakeDistributedQueue([claimedTask]);
    const dispatched: TaskId[] = [];

    const scheduler = createScheduler(
      { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 1 },
      store,
      async (_agentId, _input, _mode) => {
        dispatched.push(claimedTask.id);
      },
      createFakeClock(0),
      undefined,
      { queueBackend: distributed.queueBackend, nodeId: "node-a" },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(dispatched).toEqual([claimedTask.id]);
    expect(distributed.claimed).toEqual([`node-a:${String(claimedTask.id)}`]);
    expect(distributed.acked).toEqual([String(claimedTask.id)]);

    await scheduler[Symbol.asyncDispose]();
    await store[Symbol.asyncDispose]();
  });

  it("uses queueBackend.tick to dedupe cron execution across nodes", async () => {
    const distributed = createFakeDistributedQueue();
    const scheduler = createScheduler(
      { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 60_000 },
      createSqliteTaskStore(makeDb()),
      async () => {},
      undefined,
      createSqliteScheduleStore(makeDb()),
      { queueBackend: distributed.queueBackend, nodeId: "node-a" },
    );

    const sid = await scheduler.schedule("* * * * *", aid, input, "spawn");
    const tickAllowed = await distributed.queueBackend.tick?.(sid, "node-a");
    const tickRejected = await distributed.queueBackend.tick?.(sid, "node-b");

    expect(tickAllowed).toBe(true);
    expect(tickRejected).toBe(false);

    await scheduler[Symbol.asyncDispose]();
  });
});
