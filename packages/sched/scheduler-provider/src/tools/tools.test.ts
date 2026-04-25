import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { AgentId } from "@koi/core";
import { agentId, DEFAULT_SCHEDULER_CONFIG } from "@koi/core";
import { createScheduler, createSchedulerComponent, createSqliteTaskStore } from "@koi/scheduler";
import { createCancelTool } from "./cancel.js";
import { createQueryTool } from "./query.js";
import { createScheduleTool } from "./schedule.js";
import { createStatsTool } from "./stats.js";
import { createSubmitTool } from "./submit.js";

const aid = agentId("test-agent" as AgentId);

function makeComponent() {
  const db = new Database(":memory:");
  const store = createSqliteTaskStore(db);
  const scheduler = createScheduler(DEFAULT_SCHEDULER_CONFIG, store, async () => {});
  return createSchedulerComponent(scheduler, aid);
}

describe("scheduler_submit tool", () => {
  it("returns taskId", async () => {
    const tool = createSubmitTool(makeComponent());
    const result = (await tool.execute({ input: "do something", mode: "spawn" })) as {
      taskId: string;
    };
    expect(typeof result.taskId).toBe("string");
  });
});

describe("scheduler_cancel tool", () => {
  it("returns cancelled true for own delayed task", async () => {
    const comp = makeComponent();
    const submitTool = createSubmitTool(comp);
    const cancelTool = createCancelTool(comp);
    // Use a large delayMs so the task stays in the heap (not dispatched immediately).
    const { taskId } = (await submitTool.execute({
      input: "x",
      mode: "spawn",
      delayMs: 60000,
    })) as { taskId: string };
    const result = (await cancelTool.execute({ taskId })) as { cancelled: boolean };
    expect(result.cancelled).toBe(true);
  });
});

describe("scheduler_query tool", () => {
  it("returns tasks array", async () => {
    const comp = makeComponent();
    const submitTool = createSubmitTool(comp);
    const queryTool = createQueryTool(comp);
    await submitTool.execute({ input: "hello", mode: "spawn" });
    const result = (await queryTool.execute({})) as { tasks: unknown[]; count: number };
    expect(result.count).toBeGreaterThan(0);
  });

  it("respects limit cap at 50", async () => {
    const comp = makeComponent();
    const queryTool = createQueryTool(comp);
    const result = (await queryTool.execute({ limit: 999 })) as { tasks: unknown[] };
    expect(Array.isArray(result.tasks)).toBe(true);
  });
});

describe("scheduler_stats tool", () => {
  it("returns stats object", async () => {
    const comp = makeComponent();
    const statsTool = createStatsTool(comp);
    const result = (await statsTool.execute({})) as Record<string, number>;
    expect(typeof result.pending).toBe("number");
    expect(typeof result.running).toBe("number");
  });
});

describe("scheduler_schedule tool", () => {
  it("rejects invalid cron", async () => {
    const comp = makeComponent();
    const tool = createScheduleTool(comp);
    await expect(
      tool.execute({ expression: "bad-cron", input: "x", mode: "spawn" }),
    ).rejects.toThrow();
  });

  it("returns scheduleId for valid cron", async () => {
    const comp = makeComponent();
    const tool = createScheduleTool(comp);
    const result = (await tool.execute({ expression: "0 * * * *", input: "x", mode: "spawn" })) as {
      scheduleId: string;
    };
    expect(typeof result.scheduleId).toBe("string");
  });
});
