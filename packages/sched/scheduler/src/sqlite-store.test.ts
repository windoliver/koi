import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { CronSchedule, EngineInput, ScheduledTask, TaskRunRecord } from "@koi/core";
import { agentId, scheduleId, taskId } from "@koi/core";
import {
  createSqliteRunStore,
  createSqliteScheduleStore,
  createSqliteTaskStore,
} from "./sqlite-store.js";

function makeDb(): Database {
  return new Database(":memory:");
}

const aid = agentId("agent-1");
const input: EngineInput = { kind: "text", text: "hello" };

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: taskId("t1"),
    agentId: aid,
    input,
    mode: "spawn",
    priority: 5,
    status: "pending",
    createdAt: 1000,
    retries: 0,
    maxRetries: 3,
    ...overrides,
  } satisfies ScheduledTask;
}

describe("SqliteTaskStore", () => {
  it("save and load round-trip", async () => {
    const store = createSqliteTaskStore(makeDb());
    const task = makeTask();
    await store.save(task);
    const loaded = await store.load(task.id);
    expect(loaded?.id).toBe(task.id);
    expect(loaded?.input).toEqual(input);
    await store[Symbol.asyncDispose]();
  });

  it("loadPending returns pending tasks only", async () => {
    const store = createSqliteTaskStore(makeDb());
    await store.save(makeTask({ id: taskId("t1"), status: "pending" }));
    await store.save(makeTask({ id: taskId("t2"), status: "completed" }));
    const pending = await store.loadPending();
    expect(pending.length).toBe(1);
    expect(pending[0]?.status).toBe("pending");
    await store[Symbol.asyncDispose]();
  });

  it("updateStatus persists new status", async () => {
    const store = createSqliteTaskStore(makeDb());
    await store.save(makeTask());
    await store.updateStatus(taskId("t1"), "running", { startedAt: 2000 });
    const loaded = await store.load(taskId("t1"));
    expect(loaded?.status).toBe("running");
    expect(loaded?.startedAt).toBe(2000);
    await store[Symbol.asyncDispose]();
  });

  it("remove deletes task row", async () => {
    const store = createSqliteTaskStore(makeDb());
    await store.save(makeTask());
    await store.remove(taskId("t1"));
    expect(await store.load(taskId("t1"))).toBeUndefined();
    await store[Symbol.asyncDispose]();
  });

  it("query filters by agentId", async () => {
    const store = createSqliteTaskStore(makeDb());
    await store.save(makeTask({ id: taskId("t1"), agentId: agentId("a1") }));
    await store.save(makeTask({ id: taskId("t2"), agentId: agentId("a2") }));
    const results = await store.query({ agentId: agentId("a1") });
    expect(results.length).toBe(1);
    await store[Symbol.asyncDispose]();
  });
});

describe("SqliteScheduleStore", () => {
  it("saveSchedule and loadSchedules round-trip", async () => {
    const store = createSqliteScheduleStore(makeDb());
    const sched: CronSchedule = {
      id: scheduleId("s1"),
      expression: "0 * * * *",
      agentId: aid,
      input,
      mode: "spawn",
      paused: false,
    };
    await store.saveSchedule(sched);
    const loaded = await store.loadSchedules();
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.id).toBe(scheduleId("s1"));
    await store[Symbol.asyncDispose]();
  });

  it("saveSchedule is an upsert (pause round-trip)", async () => {
    const store = createSqliteScheduleStore(makeDb());
    const sched: CronSchedule = {
      id: scheduleId("s1"),
      expression: "0 * * * *",
      agentId: aid,
      input,
      mode: "spawn",
      paused: false,
    };
    await store.saveSchedule(sched);
    await store.saveSchedule({ ...sched, paused: true });
    const loaded = await store.loadSchedules();
    expect(loaded[0]?.paused).toBe(true);
    await store[Symbol.asyncDispose]();
  });

  it("removeSchedule deletes entry", async () => {
    const store = createSqliteScheduleStore(makeDb());
    const sched: CronSchedule = {
      id: scheduleId("s1"),
      expression: "0 * * * *",
      agentId: aid,
      input,
      mode: "spawn",
      paused: false,
    };
    await store.saveSchedule(sched);
    await store.removeSchedule(scheduleId("s1"));
    expect((await store.loadSchedules()).length).toBe(0);
    await store[Symbol.asyncDispose]();
  });
});

describe("SqliteRunStore", () => {
  it("saveRun and loadRuns round-trip", async () => {
    const store = createSqliteRunStore(makeDb());
    const run: TaskRunRecord = {
      taskId: taskId("t1"),
      agentId: aid,
      status: "completed",
      startedAt: 1000,
      completedAt: 2000,
      durationMs: 1000,
      retryAttempt: 0,
    };
    store.saveRun(run);
    const loaded = store.loadRuns(taskId("t1"));
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.status).toBe("completed");
    expect(loaded[0]?.durationMs).toBe(1000);
    await store[Symbol.asyncDispose]();
  });

  it("saveRun upserts on same retry_attempt", async () => {
    const store = createSqliteRunStore(makeDb());
    const run: TaskRunRecord = {
      taskId: taskId("t1"),
      agentId: aid,
      status: "failed",
      startedAt: 1000,
      completedAt: 2000,
      durationMs: 1000,
      retryAttempt: 0,
      error: "oops",
    };
    store.saveRun(run);
    store.saveRun({ ...run, error: "updated" });
    const loaded = store.loadRuns(taskId("t1"));
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.error).toBe("updated");
    await store[Symbol.asyncDispose]();
  });
});
