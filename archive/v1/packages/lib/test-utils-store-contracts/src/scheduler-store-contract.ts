/**
 * Reusable contract test suites for TaskStore and ScheduleStore implementations.
 *
 * Validates that any implementation (SQLite, Nexus, in-memory) satisfies
 * the L0 contracts with consistent behavior across save/load/query/update.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { CronSchedule, ScheduledTask, ScheduleStore, TaskStore } from "@koi/core";
import { agentId, scheduleId, taskId } from "@koi/core";

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

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

function makeSchedule(overrides?: Partial<CronSchedule>): CronSchedule {
  return {
    id: scheduleId("sched_1"),
    expression: "0 0 * * *",
    agentId: agentId("agent_1"),
    input: { kind: "text", text: "cron" },
    mode: "spawn",
    paused: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TaskStore contract tests
// ---------------------------------------------------------------------------

export function runTaskStoreContractTests(
  createStore: () => TaskStore | Promise<TaskStore>,
  cleanup?: () => void | Promise<void>,
): void {
  describe("TaskStore contract", () => {
    let store: TaskStore;

    beforeEach(async () => {
      if (cleanup !== undefined) await cleanup();
      store = await createStore();
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
      expect(loaded?.retries).toBe(0);
      expect(loaded?.maxRetries).toBe(3);
    });

    test("load returns undefined for non-existent task", async () => {
      const loaded = await store.load(taskId("nonexistent"));
      expect(loaded).toBeUndefined();
    });

    test("save with metadata round-trips correctly", async () => {
      await store.save(makeTask({ metadata: { foo: "bar", count: 42 } }));
      const loaded = await store.load(taskId("task_1"));
      expect(loaded?.metadata).toEqual({ foo: "bar", count: 42 });
    });

    test("save with scheduledAt round-trips correctly", async () => {
      await store.save(makeTask({ scheduledAt: 5000 }));
      const loaded = await store.load(taskId("task_1"));
      expect(loaded?.scheduledAt).toBe(5000);
    });

    test("save with timeoutMs round-trips correctly", async () => {
      await store.save(makeTask({ timeoutMs: 5000 }));
      const loaded = await store.load(taskId("task_1"));
      expect(loaded?.timeoutMs).toBe(5000);
    });

    test("idempotent save (INSERT OR REPLACE)", async () => {
      await store.save(makeTask({ status: "pending" }));
      await store.save(makeTask({ status: "running" }));
      const loaded = await store.load(taskId("task_1"));
      expect(loaded?.status).toBe("running");
    });

    test("remove deletes task", async () => {
      await store.save(makeTask());
      await store.remove(taskId("task_1"));
      const loaded = await store.load(taskId("task_1"));
      expect(loaded).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // updateStatus
    // -----------------------------------------------------------------------

    test("updateStatus changes status", async () => {
      await store.save(makeTask());
      await store.updateStatus(taskId("task_1"), "running", { startedAt: 2000 });
      const loaded = await store.load(taskId("task_1"));
      expect(loaded?.status).toBe("running");
      expect(loaded?.startedAt).toBe(2000);
    });

    test("updateStatus pending → running → completed", async () => {
      await store.save(makeTask());
      await store.updateStatus(taskId("task_1"), "running", { startedAt: 2000 });
      await store.updateStatus(taskId("task_1"), "completed", { completedAt: 3000 });
      const loaded = await store.load(taskId("task_1"));
      expect(loaded?.status).toBe("completed");
      expect(loaded?.completedAt).toBe(3000);
    });

    test("updateStatus pending → running → failed → dead_letter", async () => {
      await store.save(makeTask());
      await store.updateStatus(taskId("task_1"), "running", { startedAt: 2000 });
      const error = { code: "EXTERNAL" as const, message: "boom", retryable: true };
      await store.updateStatus(taskId("task_1"), "failed", { lastError: error, retries: 1 });

      const failed = await store.load(taskId("task_1"));
      expect(failed?.status).toBe("failed");
      expect(failed?.lastError?.message).toBe("boom");
      expect(failed?.retries).toBe(1);

      await store.updateStatus(taskId("task_1"), "dead_letter", { retries: 3 });
      const dl = await store.load(taskId("task_1"));
      expect(dl?.status).toBe("dead_letter");
    });

    // -----------------------------------------------------------------------
    // query
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // loadPending
    // -----------------------------------------------------------------------

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
  });
}

// ---------------------------------------------------------------------------
// ScheduleStore contract tests
// ---------------------------------------------------------------------------

export function runScheduleStoreContractTests(
  createStore: () => ScheduleStore | Promise<ScheduleStore>,
  cleanup?: () => void | Promise<void>,
): void {
  describe("ScheduleStore contract", () => {
    let store: ScheduleStore;

    beforeEach(async () => {
      if (cleanup !== undefined) await cleanup();
      store = await createStore();
    });

    test("saveSchedule and loadSchedules round-trip", async () => {
      const schedule = makeSchedule();
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
      const schedule = makeSchedule({
        id: scheduleId("sched_2"),
        expression: "*/5 * * * *",
        mode: "dispatch",
        taskOptions: { priority: 1, maxRetries: 5 },
        timezone: "America/New_York",
        paused: true,
      });

      await store.saveSchedule(schedule);
      const loaded = await store.loadSchedules();

      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.taskOptions).toEqual({ priority: 1, maxRetries: 5 });
      expect(loaded[0]?.timezone).toBe("America/New_York");
      expect(loaded[0]?.paused).toBe(true);
    });

    test("removeSchedule deletes schedule", async () => {
      await store.saveSchedule(makeSchedule());
      await store.removeSchedule(scheduleId("sched_1"));
      const loaded = await store.loadSchedules();
      expect(loaded).toHaveLength(0);
    });

    test("multiple schedules", async () => {
      await store.saveSchedule(makeSchedule({ id: scheduleId("s1") }));
      await store.saveSchedule(makeSchedule({ id: scheduleId("s2") }));
      await store.saveSchedule(makeSchedule({ id: scheduleId("s3") }));
      const loaded = await store.loadSchedules();
      expect(loaded).toHaveLength(3);
    });

    test("paused flag is preserved", async () => {
      await store.saveSchedule(makeSchedule({ paused: true }));
      const loaded = await store.loadSchedules();
      expect(loaded[0]?.paused).toBe(true);
    });
  });
}
