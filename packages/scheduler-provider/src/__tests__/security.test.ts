import { describe, expect, test } from "bun:test";
import type { AgentId, TaskFilter, TaskHistoryFilter, TaskScheduler, Tool } from "@koi/core";
import { scheduleId, taskId, toolToken } from "@koi/core";
import { createSchedulerProvider } from "../scheduler-component-provider.js";
import { createMockAgent } from "../test-helpers.js";

/**
 * Creates a TaskScheduler that captures all calls for assertion.
 */
function createCapturingTaskScheduler() {
  const submitCalls: { readonly agentId: AgentId }[] = [];
  const scheduleCalls: { readonly agentId: AgentId }[] = [];
  const queryCalls: { readonly filter: TaskFilter }[] = [];
  const historyCalls: { readonly filter: TaskHistoryFilter }[] = [];

  const scheduler: TaskScheduler = {
    submit: (id: AgentId) => {
      submitCalls.push({ agentId: id });
      return taskId("task-1");
    },
    cancel: () => true,
    schedule: (_expr: string, id: AgentId) => {
      scheduleCalls.push({ agentId: id });
      return scheduleId("sch-1");
    },
    unschedule: () => true,
    pause: () => true,
    resume: () => true,
    query: (filter: TaskFilter) => {
      queryCalls.push({ filter });
      return [];
    },
    stats: () => ({
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      deadLettered: 0,
      activeSchedules: 0,
      pausedSchedules: 0,
    }),
    history: (filter: TaskHistoryFilter) => {
      historyCalls.push({ filter });
      return [];
    },
    watch: () => () => {},
    [Symbol.asyncDispose]: async () => {},
  };

  return { scheduler, submitCalls, scheduleCalls, queryCalls, historyCalls };
}

describe("scheduler security — agentId pinning", () => {
  test("no tool inputSchema contains an agentId property", async () => {
    const { scheduler } = createCapturingTaskScheduler();
    const provider = createSchedulerProvider({ scheduler });
    const components = await provider.attach(createMockAgent("pinned-agent"));

    for (const [key, value] of components) {
      if (typeof key === "string" && key.startsWith("tool:")) {
        const tool = value as Tool;
        const schema = tool.descriptor.inputSchema as Record<string, unknown>;
        const properties = schema.properties as Record<string, unknown> | undefined;
        if (properties !== undefined) {
          expect(properties).not.toHaveProperty("agentId");
        }
      }
    }
  });

  test("scheduler_submit always uses attached agent's ID", async () => {
    const { scheduler, submitCalls } = createCapturingTaskScheduler();
    const provider = createSchedulerProvider({ scheduler });
    const agent = createMockAgent("my-agent");
    const components = await provider.attach(agent);

    const submitTool = components.get(toolToken("scheduler_submit") as string) as Tool;
    await submitTool.execute({ input: "test", mode: "spawn" });

    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]?.agentId as string).toBe("my-agent");
  });

  test("scheduler_schedule always uses attached agent's ID", async () => {
    const { scheduler, scheduleCalls } = createCapturingTaskScheduler();
    const provider = createSchedulerProvider({ scheduler });
    const agent = createMockAgent("sched-agent");
    const components = await provider.attach(agent);

    const scheduleTool = components.get(toolToken("scheduler_schedule") as string) as Tool;
    await scheduleTool.execute({
      expression: "0 0 * * *",
      input: "task",
      mode: "spawn",
    });

    expect(scheduleCalls).toHaveLength(1);
    expect(scheduleCalls[0]?.agentId as string).toBe("sched-agent");
  });

  test("scheduler_query auto-filters by own agentId", async () => {
    const { scheduler, queryCalls } = createCapturingTaskScheduler();
    const provider = createSchedulerProvider({ scheduler });
    const agent = createMockAgent("query-agent");
    const components = await provider.attach(agent);

    const queryTool = components.get(toolToken("scheduler_query") as string) as Tool;
    await queryTool.execute({ status: "pending" });

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]?.filter.agentId as string).toBe("query-agent");
  });

  test("scheduler_history auto-filters by own agentId", async () => {
    const { scheduler, historyCalls } = createCapturingTaskScheduler();
    const provider = createSchedulerProvider({ scheduler });
    const agent = createMockAgent("history-agent");
    const components = await provider.attach(agent);

    const historyTool = components.get(toolToken("scheduler_history") as string) as Tool;
    await historyTool.execute({ status: "completed" });

    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0]?.filter.agentId as string).toBe("history-agent");
  });
});
