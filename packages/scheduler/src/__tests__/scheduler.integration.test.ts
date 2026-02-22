import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SchedulerConfig } from "@koi/core";
import { agentId, DEFAULT_SCHEDULER_CONFIG } from "@koi/core";
import type { TaskDispatcher } from "../scheduler.js";
import { createScheduler } from "../scheduler.js";
import { createSqliteTaskStore } from "../sqlite-store.js";

describe("Scheduler integration (real SQLite + SystemClock)", () => {
  let dispose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (dispose !== undefined) {
      await dispose();
      dispose = undefined;
    }
  });

  test("submit delayed task → persist → new scheduler loads and dispatches", async () => {
    const db = new Database(":memory:");
    const store1 = createSqliteTaskStore(db);
    const dispatcher1 = mock<TaskDispatcher>(() => Promise.resolve("ok"));
    const config: SchedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      pollIntervalMs: 5_000,
    };

    const scheduler1 = createScheduler(config, store1, dispatcher1);
    // Use delayMs so the immediate poll skips it (scheduledAt is in the future)
    await scheduler1.submit(agentId("a1"), { kind: "text", text: "persisted" }, "spawn", {
      delayMs: 100,
    });
    await scheduler1[Symbol.asyncDispose]();

    // Verify task persisted as pending
    const pending = await store1.loadPending();
    expect(pending.length).toBeGreaterThanOrEqual(1);

    // Create new scheduler on same db — should pick up pending task
    const store2 = createSqliteTaskStore(db);
    const dispatcher2 = mock<TaskDispatcher>(() => Promise.resolve("ok"));
    const config2: SchedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      pollIntervalMs: 50,
    };
    const scheduler2 = createScheduler(config2, store2, dispatcher2);
    dispose = async () => scheduler2[Symbol.asyncDispose]();

    // Wait for delay to expire + poll + dispatch
    await new Promise((r) => setTimeout(r, 300));

    expect(dispatcher2).toHaveBeenCalledTimes(1);
  });

  test("submit and dispatch with real system clock", async () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const dispatcher = mock<TaskDispatcher>(() => Promise.resolve("ok"));
    const config: SchedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      pollIntervalMs: 50,
    };

    const scheduler = createScheduler(config, store, dispatcher);
    dispose = async () => scheduler[Symbol.asyncDispose]();

    await scheduler.submit(agentId("a1"), { kind: "text", text: "real" }, "dispatch");

    // Immediate poll dispatches; allow microtasks
    await new Promise((r) => setTimeout(r, 50));

    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(dispatcher.mock.calls[0]?.[2]).toBe("dispatch");
  });
});
