import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SchedulerConfig, SchedulerEvent } from "@koi/core";
import { agentId, DEFAULT_SCHEDULER_CONFIG } from "@koi/core";
import type { TaskDispatcher } from "../scheduler.js";
import { createScheduler } from "../scheduler.js";
import { createSqliteTaskStore } from "../sqlite-store.js";

describe("Cron integration", () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (dispose !== undefined) {
      await dispose();
      dispose = undefined;
    }
  });

  test("valid cron expression accepted", async () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const dispatcher = mock<TaskDispatcher>(() => Promise.resolve("ok"));
    const config: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 50 };
    const scheduler = createScheduler(config, store, dispatcher);
    dispose = async () => scheduler[Symbol.asyncDispose]();

    const id = await scheduler.schedule(
      "* * * * *",
      agentId("a1"),
      { kind: "text", text: "cron" },
      "spawn",
    );
    expect(typeof id).toBe("string");
    expect(id).toContain("sched_");
  });

  test("invalid cron expression throws", async () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const dispatcher = mock<TaskDispatcher>(() => Promise.resolve("ok"));
    const config: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 50 };
    const scheduler = createScheduler(config, store, dispatcher);
    dispose = async () => scheduler[Symbol.asyncDispose]();

    expect(
      scheduler.schedule("invalid cron", agentId("a1"), { kind: "text", text: "bad" }, "spawn"),
    ).rejects.toThrow();
  });

  test("schedule + unschedule lifecycle", async () => {
    const events: SchedulerEvent[] = [];
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const dispatcher = mock<TaskDispatcher>(() => Promise.resolve("ok"));
    const config: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 50 };
    const scheduler = createScheduler(config, store, dispatcher);
    dispose = async () => scheduler[Symbol.asyncDispose]();
    scheduler.watch((e) => events.push(e));

    const id = await scheduler.schedule(
      "* * * * *",
      agentId("a1"),
      { kind: "text", text: "cron" },
      "spawn",
    );

    expect(scheduler.stats().activeSchedules).toBe(1);

    const removed = await scheduler.unschedule(id);
    expect(removed).toBe(true);
    expect(scheduler.stats().activeSchedules).toBe(0);

    // Verify events
    const created = events.filter((e) => e.kind === "schedule:created");
    const removedEvents = events.filter((e) => e.kind === "schedule:removed");
    expect(created.length).toBe(1);
    expect(removedEvents.length).toBe(1);
  });

  test("unschedule returns false for unknown schedule", async () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const dispatcher = mock<TaskDispatcher>(() => Promise.resolve("ok"));
    const config: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 50 };
    const scheduler = createScheduler(config, store, dispatcher);
    dispose = async () => scheduler[Symbol.asyncDispose]();

    const { scheduleId } = await import("@koi/core");
    const removed = await scheduler.unschedule(scheduleId("nonexistent"));
    expect(removed).toBe(false);
  });

  test("schedule after dispose throws", async () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const dispatcher = mock<TaskDispatcher>(() => Promise.resolve("ok"));
    const config: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 50 };
    const scheduler = createScheduler(config, store, dispatcher);

    await scheduler[Symbol.asyncDispose]();

    expect(
      scheduler.schedule(
        "* * * * *",
        agentId("a1"),
        { kind: "text", text: "after dispose" },
        "spawn",
      ),
    ).rejects.toThrow("Scheduler is disposed");
  });

  // Gap 3: schedule persistence across restart
  test("schedule persists across scheduler restart", async () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const dispatcher1 = mock<TaskDispatcher>(() => Promise.resolve("ok"));
    const config: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 50 };

    // Create scheduler with scheduleStore, schedule a cron
    const scheduler1 = createScheduler(config, store, dispatcher1, undefined, store);
    await scheduler1.schedule(
      "* * * * *",
      agentId("a1"),
      { kind: "text", text: "persistent" },
      "spawn",
    );
    expect(scheduler1.stats().activeSchedules).toBe(1);

    // Dispose first scheduler
    await scheduler1[Symbol.asyncDispose]();

    // Create new scheduler on same db — should restore the schedule
    const store2 = createSqliteTaskStore(db);
    const dispatcher2 = mock<TaskDispatcher>(() => Promise.resolve("ok"));
    const scheduler2 = createScheduler(config, store2, dispatcher2, undefined, store2);
    dispose = async () => scheduler2[Symbol.asyncDispose]();

    // Wait for init
    await new Promise((r) => setTimeout(r, 50));

    expect(scheduler2.stats().activeSchedules).toBe(1);
  });

  test("unschedule removes from schedule store", async () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const dispatcher = mock<TaskDispatcher>(() => Promise.resolve("ok"));
    const config: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 50 };

    const scheduler = createScheduler(config, store, dispatcher, undefined, store);
    dispose = async () => scheduler[Symbol.asyncDispose]();

    const id = await scheduler.schedule(
      "* * * * *",
      agentId("a1"),
      { kind: "text", text: "temp" },
      "spawn",
    );

    await scheduler.unschedule(id);

    // Verify store is empty
    const schedules = await store.loadSchedules();
    expect(schedules).toHaveLength(0);
  });

  test("no scheduleStore — schedule works without persistence", async () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const dispatcher = mock<TaskDispatcher>(() => Promise.resolve("ok"));
    const config: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, pollIntervalMs: 50 };

    // No scheduleStore passed
    const scheduler = createScheduler(config, store, dispatcher);
    dispose = async () => scheduler[Symbol.asyncDispose]();

    const id = await scheduler.schedule(
      "* * * * *",
      agentId("a1"),
      { kind: "text", text: "ephemeral" },
      "spawn",
    );

    expect(scheduler.stats().activeSchedules).toBe(1);

    const removed = await scheduler.unschedule(id);
    expect(removed).toBe(true);
    expect(scheduler.stats().activeSchedules).toBe(0);
  });
});
