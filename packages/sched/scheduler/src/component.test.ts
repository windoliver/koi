import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { AgentId, EngineInput, SchedulerComponent } from "@koi/core";
import { agentId, DEFAULT_SCHEDULER_CONFIG } from "@koi/core";
import { createSchedulerComponent } from "./component.js";
import { createScheduler } from "./scheduler.js";
import { createSqliteTaskStore } from "./sqlite-store.js";

const a1 = agentId("agent-1" as AgentId);
const a2 = agentId("agent-2" as AgentId);
const input: EngineInput = { kind: "text", text: "hello" };

function makeComponent(aid: AgentId): SchedulerComponent {
  const db = new Database(":memory:");
  const store = createSqliteTaskStore(db);
  const scheduler = createScheduler(DEFAULT_SCHEDULER_CONFIG, store, async () => {});
  return createSchedulerComponent(scheduler, aid);
}

describe("createSchedulerComponent", () => {
  it("submit is agent-scoped", async () => {
    const comp = makeComponent(a1);
    const id = await comp.submit(input, "spawn");
    expect(typeof id).toBe("string");
  });

  it("query only returns own agent tasks", async () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const scheduler = createScheduler(DEFAULT_SCHEDULER_CONFIG, store, async () => {});
    const c1 = createSchedulerComponent(scheduler, a1);
    const c2 = createSchedulerComponent(scheduler, a2);
    await c1.submit(input, "spawn");
    await c2.submit(input, "spawn");
    const tasks1 = await c1.query({});
    const tasks2 = await c2.query({});
    expect(tasks1.every((t) => t.agentId === a1)).toBe(true);
    expect(tasks2.every((t) => t.agentId === a2)).toBe(true);
    await scheduler[Symbol.asyncDispose]();
  });

  it("cancel rejects foreign task ID", async () => {
    const db = new Database(":memory:");
    const store = createSqliteTaskStore(db);
    const scheduler = createScheduler(DEFAULT_SCHEDULER_CONFIG, store, async () => {});
    const c1 = createSchedulerComponent(scheduler, a1);
    const c2 = createSchedulerComponent(scheduler, a2);
    const id = await c1.submit(input, "spawn");
    const result = await c2.cancel(id);
    expect(result).toBe(false); // c2 cannot cancel c1's task
    await scheduler[Symbol.asyncDispose]();
  });

  it("stats returns agent-scoped counts", async () => {
    const comp = makeComponent(a1);
    await comp.submit(input, "spawn");
    const s = await comp.stats();
    // Task may have completed already (no-op dispatcher is instant), so check
    // the total across all terminal and non-terminal states is >= 1.
    expect(s.pending + s.running + s.completed + s.failed + s.deadLettered).toBeGreaterThanOrEqual(
      1,
    );
  });
});
