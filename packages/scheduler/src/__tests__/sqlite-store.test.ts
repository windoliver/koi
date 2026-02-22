import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { CronSchedule, ScheduledTask } from "@koi/core";
import { agentId, scheduleId, taskId } from "@koi/core";
import type { SqliteTaskStore } from "../sqlite-store.js";
import { createSqliteTaskStore } from "../sqlite-store.js";

function makeTask(overrides?: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: taskId("task_1"),
    agentId: agentId("agent_1"),
    input: { kind: "text", text: "hello" },
    mode: "spawn",
    priority: 5,
    status: "pending",
    createdAt: 1000,
    retries: 0,
    maxRetries: 3,
    ...overrides,
  };
}

describe("SqliteTaskStore", () => {
  let db: Database;
  let store: SqliteTaskStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = createSqliteTaskStore(db);
  });

  test("save and load round-trip", async () => {
    const task = makeTask();
    await store.save(task);
    const loaded = await store.load(taskId("task_1"));

    expect(loaded).toBeDefined();
    expect(loaded?.id).toBe(taskId("task_1"));
    expect(loaded?.agentId).toBe(agentId("agent_1"));
    expect(loaded?.input).toEqual({ kind: "text", text: "hello" });
    expect(loaded?.mode).toBe("spawn");
    expect(loaded?.priority).toBe(5);
    expect(loaded?.status).toBe("pending");
  });

  test("load returns undefined for non-existent task", async () => {
    const loaded = await store.load(taskId("nonexistent"));
    expect(loaded).toBeUndefined();
  });

  test("query by status", async () => {
    await store.save(makeTask({ id: taskId("t1"), status: "pending" }));
    await store.save(makeTask({ id: taskId("t2"), status: "running" }));
    await store.save(makeTask({ id: taskId("t3"), status: "pending" }));

    const pending = await store.query({ status: "pending" });
    expect(pending).toHaveLength(2);
  });

  test("query by agentId", async () => {
    await store.save(makeTask({ id: taskId("t1"), agentId: agentId("a1") }));
    await store.save(makeTask({ id: taskId("t2"), agentId: agentId("a2") }));
    await store.save(makeTask({ id: taskId("t3"), agentId: agentId("a1") }));

    const results = await store.query({ agentId: agentId("a1") });
    expect(results).toHaveLength(2);
  });

  test("query with limit", async () => {
    await store.save(makeTask({ id: taskId("t1") }));
    await store.save(makeTask({ id: taskId("t2") }));
    await store.save(makeTask({ id: taskId("t3") }));

    const results = await store.query({ limit: 2 });
    expect(results).toHaveLength(2);
  });

  test("updateStatus changes status and patch fields", async () => {
    await store.save(makeTask());
    await store.updateStatus(taskId("task_1"), "running", { startedAt: 2000 });

    const loaded = await store.load(taskId("task_1"));
    expect(loaded?.status).toBe("running");
    expect(loaded?.startedAt).toBe(2000);
  });

  test("updateStatus with lastError patch", async () => {
    await store.save(makeTask());
    const error = {
      code: "EXTERNAL" as const,
      message: "boom",
      retryable: true,
    };
    await store.updateStatus(taskId("task_1"), "failed", { lastError: error, retries: 1 });

    const loaded = await store.load(taskId("task_1"));
    expect(loaded?.status).toBe("failed");
    expect(loaded?.lastError?.message).toBe("boom");
    expect(loaded?.retries).toBe(1);
  });

  test("loadPending returns tasks ordered by priority then createdAt", async () => {
    await store.save(makeTask({ id: taskId("t1"), priority: 5, createdAt: 100 }));
    await store.save(makeTask({ id: taskId("t2"), priority: 1, createdAt: 200 }));
    await store.save(makeTask({ id: taskId("t3"), priority: 5, createdAt: 50 }));
    await store.save(makeTask({ id: taskId("t4"), status: "running" }));

    const pending = await store.loadPending();
    expect(pending).toHaveLength(3);
    expect(pending[0]?.id).toBe(taskId("t2")); // priority 1
    expect(pending[1]?.id).toBe(taskId("t3")); // priority 5, createdAt 50
    expect(pending[2]?.id).toBe(taskId("t1")); // priority 5, createdAt 100
  });

  test("remove deletes task", async () => {
    await store.save(makeTask());
    await store.remove(taskId("task_1"));

    const loaded = await store.load(taskId("task_1"));
    expect(loaded).toBeUndefined();
  });

  test("idempotent table creation", async () => {
    // Creating a second store on the same db should not throw
    const store2 = createSqliteTaskStore(db);
    await store2.save(makeTask({ id: taskId("t2") }));
    const loaded = await store2.load(taskId("t2"));
    expect(loaded).toBeDefined();
  });

  test("save with metadata round-trips correctly", async () => {
    await store.save(
      makeTask({
        metadata: { foo: "bar", count: 42 },
      }),
    );

    const loaded = await store.load(taskId("task_1"));
    expect(loaded?.metadata).toEqual({ foo: "bar", count: 42 });
  });

  test("save with scheduledAt round-trips correctly", async () => {
    await store.save(makeTask({ scheduledAt: 5000 }));

    const loaded = await store.load(taskId("task_1"));
    expect(loaded?.scheduledAt).toBe(5000);
  });

  test("purge removes completed tasks older than threshold", async () => {
    const now = Date.now();
    await store.save(
      makeTask({ id: taskId("old"), status: "completed", completedAt: now - 10_000 }),
    );
    await store.save(makeTask({ id: taskId("new"), status: "completed", completedAt: now }));
    await store.save(makeTask({ id: taskId("pending"), status: "pending" }));

    store.purge(5_000); // remove tasks completed more than 5s ago

    expect(await store.load(taskId("old"))).toBeUndefined();
    expect(await store.load(taskId("new"))).toBeDefined();
    expect(await store.load(taskId("pending"))).toBeDefined();
  });

  test("purge removes dead_letter tasks older than threshold", async () => {
    const now = Date.now();
    await store.save(
      makeTask({ id: taskId("dl"), status: "dead_letter", completedAt: now - 10_000 }),
    );

    store.purge(5_000);

    expect(await store.load(taskId("dl"))).toBeUndefined();
  });

  // Gap 1: timeoutMs persistence
  test("save with timeoutMs round-trips correctly", async () => {
    await store.save(makeTask({ timeoutMs: 5000 }));

    const loaded = await store.load(taskId("task_1"));
    expect(loaded?.timeoutMs).toBe(5000);
  });

  test("save without timeoutMs returns undefined", async () => {
    await store.save(makeTask());

    const loaded = await store.load(taskId("task_1"));
    expect(loaded?.timeoutMs).toBeUndefined();
  });

  // Gap 3: schedule persistence
  test("saveSchedule and loadSchedules round-trip", async () => {
    const schedule: CronSchedule = {
      id: scheduleId("sched_1"),
      expression: "0 0 * * *",
      agentId: agentId("agent_1"),
      input: { kind: "text", text: "cron" },
      mode: "spawn",
      paused: false,
    };

    await store.saveSchedule(schedule);
    const loaded = await store.loadSchedules();

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe(scheduleId("sched_1"));
    expect(loaded[0]?.expression).toBe("0 0 * * *");
    expect(loaded[0]?.agentId).toBe(agentId("agent_1"));
    expect(loaded[0]?.input).toEqual({ kind: "text", text: "cron" });
    expect(loaded[0]?.mode).toBe("spawn");
    expect(loaded[0]?.paused).toBe(false);
  });

  test("saveSchedule with taskOptions and timezone", async () => {
    const schedule: CronSchedule = {
      id: scheduleId("sched_2"),
      expression: "*/5 * * * *",
      agentId: agentId("agent_2"),
      input: { kind: "text", text: "timed" },
      mode: "dispatch",
      taskOptions: { priority: 1, maxRetries: 5 },
      timezone: "America/New_York",
      paused: true,
    };

    await store.saveSchedule(schedule);
    const loaded = await store.loadSchedules();

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.taskOptions).toEqual({ priority: 1, maxRetries: 5 });
    expect(loaded[0]?.timezone).toBe("America/New_York");
    expect(loaded[0]?.paused).toBe(true);
  });

  test("removeSchedule deletes schedule", async () => {
    const schedule: CronSchedule = {
      id: scheduleId("sched_3"),
      expression: "0 0 * * *",
      agentId: agentId("agent_1"),
      input: { kind: "text", text: "cron" },
      mode: "spawn",
      paused: false,
    };

    await store.saveSchedule(schedule);
    await store.removeSchedule(scheduleId("sched_3"));
    const loaded = await store.loadSchedules();

    expect(loaded).toHaveLength(0);
  });
});
