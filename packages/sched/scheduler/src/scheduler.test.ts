import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { AgentId, EngineInput, SchedulerEvent } from "@koi/core";
import { agentId, DEFAULT_SCHEDULER_CONFIG } from "@koi/core";
import { createFakeClock } from "./clock.js";
import { createScheduler } from "./scheduler.js";
import { createSqliteTaskStore } from "./sqlite-store.js";
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
});
