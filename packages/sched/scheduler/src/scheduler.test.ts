import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { AgentId, CronSchedule, EngineInput, SchedulerEvent } from "@koi/core";
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
    const beforeDispose = s1.querySchedules(aid);
    expect(beforeDispose.find((s: CronSchedule) => s.id === sid)?.paused).toBe(true);
    await s1[Symbol.asyncDispose]();

    // Recreate from same DB — paused state must survive
    const s2 = make();
    // Give init() a tick to load from store
    await new Promise<void>((r) => globalThis.setTimeout(r, 20));
    const afterRestore = s2.querySchedules(aid);
    expect(afterRestore.find((s: CronSchedule) => s.id === sid)?.paused).toBe(true);
    await s2[Symbol.asyncDispose]();
  });
});
