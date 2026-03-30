import { describe, expect, test } from "bun:test";
import type { Agent, AgentId, ScheduleId, TaskId, TaskScheduler, Tool } from "@koi/core";
import { agentId, scheduleId, taskId } from "@koi/core";
import { createSchedulerRegistration } from "./registration.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function stubAgent(id: string = "test-agent"): Agent {
  const components = new Map<string, unknown>();
  return {
    pid: {
      id: agentId(id),
      name: "test",
      type: "copilot",
      depth: 0,
    },
    manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
    state: "running",
    component: (token) => components.get(token as string) as undefined,
    has: (token) => components.has(token as string),
    hasAll: (...tokens) => tokens.every((t) => components.has(t as string)),
    query: () => new Map(),
    components: () => components,
  };
}

/** Stub TaskScheduler that records calls and returns minimal valid responses. */
function stubScheduler(): TaskScheduler & {
  readonly calls: readonly { readonly method: string; readonly args: readonly unknown[] }[];
} {
  const calls: { readonly method: string; readonly args: readonly unknown[] }[] = [];
  return {
    get calls() {
      return calls;
    },
    submit: (...args: readonly unknown[]): TaskId => {
      calls.push({ method: "submit", args });
      return taskId("task-1");
    },
    cancel: (...args: readonly unknown[]): boolean => {
      calls.push({ method: "cancel", args });
      return true;
    },
    schedule: (...args: readonly unknown[]): ScheduleId => {
      calls.push({ method: "schedule", args });
      return scheduleId("sched-1");
    },
    unschedule: (...args: readonly unknown[]): boolean => {
      calls.push({ method: "unschedule", args });
      return true;
    },
    pause: (...args: readonly unknown[]): boolean => {
      calls.push({ method: "pause", args });
      return true;
    },
    resume: (...args: readonly unknown[]): boolean => {
      calls.push({ method: "resume", args });
      return true;
    },
    query: (...args: readonly unknown[]) => {
      calls.push({ method: "query", args });
      return [
        {
          id: taskId("task-1"),
          agentId: agentId("test-agent") as AgentId,
          input: { kind: "text" as const, text: "test" },
          mode: "spawn" as const,
          priority: 5,
          status: "pending" as const,
          createdAt: Date.now(),
          retries: 0,
          maxRetries: 3,
        },
      ];
    },
    stats: () => {
      calls.push({ method: "stats", args: [] });
      return {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        deadLettered: 0,
        activeSchedules: 0,
        pausedSchedules: 0,
      };
    },
    history: (...args: readonly unknown[]) => {
      calls.push({ method: "history", args });
      return [];
    },
    watch: () => () => {},
    [Symbol.asyncDispose]: async () => {},
  };
}

// ---------------------------------------------------------------------------
// createSchedulerRegistration
// ---------------------------------------------------------------------------

describe("createSchedulerRegistration", () => {
  test("returns correct name", () => {
    const reg = createSchedulerRegistration({ scheduler: stubScheduler() });
    expect(reg.name).toBe("scheduler");
  });

  test("provides 9 tool factories by default", () => {
    const reg = createSchedulerRegistration({ scheduler: stubScheduler() });
    expect(reg.tools).toHaveLength(9);

    const names = reg.tools.map((f) => f.name);
    expect(names).toContain("scheduler_submit");
    expect(names).toContain("scheduler_cancel");
    expect(names).toContain("scheduler_schedule");
    expect(names).toContain("scheduler_unschedule");
    expect(names).toContain("scheduler_query");
    expect(names).toContain("scheduler_stats");
    expect(names).toContain("scheduler_pause");
    expect(names).toContain("scheduler_resume");
    expect(names).toContain("scheduler_history");
  });

  test("tool factories produce valid Tool objects", async () => {
    const reg = createSchedulerRegistration({ scheduler: stubScheduler() });
    const agent = stubAgent();

    for (const factory of reg.tools) {
      const tool = (await factory.create(agent)) as Tool;
      expect(tool.descriptor).toBeDefined();
      expect(tool.descriptor.name).toBe(factory.name);
      expect(tool.descriptor.description.length).toBeGreaterThan(0);
      expect(typeof tool.execute).toBe("function");
    }
  });

  test("all tools created from same agent share a single SchedulerComponent", async () => {
    const scheduler = stubScheduler();
    const reg = createSchedulerRegistration({ scheduler });
    const agent = stubAgent();

    // Create submit and cancel tools for the same agent
    const submitFactory = reg.tools.find((f) => f.name === "scheduler_submit");
    const cancelFactory = reg.tools.find((f) => f.name === "scheduler_cancel");
    expect(submitFactory).toBeDefined();
    expect(cancelFactory).toBeDefined();

    const submitTool = (await submitFactory?.create(agent)) as Tool;
    const cancelTool = (await cancelFactory?.create(agent)) as Tool;

    // Submit a task via the submit tool
    await submitTool.execute({ input: "hello", mode: "spawn" });

    // The submit call should pin the agent's ID
    const submitCall = scheduler.calls.find((c) => c.method === "submit");
    expect(submitCall).toBeDefined();
    expect(submitCall?.args[0]).toBe(agentId("test-agent"));

    // Cancel via cancel tool — it queries with the same pinned agentId first
    await cancelTool.execute({ taskId: "task-1" });
    const queryCall = scheduler.calls.find((c) => c.method === "query");
    expect(queryCall).toBeDefined();
    // The query filter should inject the same agentId, proving shared component
    const filter = queryCall?.args[0] as { readonly agentId: AgentId };
    expect(filter.agentId).toBe(agentId("test-agent"));
  });

  test("different agents get separate SchedulerComponent instances", async () => {
    const scheduler = stubScheduler();
    const reg = createSchedulerRegistration({ scheduler });
    const agent1 = stubAgent("agent-1");
    const agent2 = stubAgent("agent-2");

    const submitFactory = reg.tools.find((f) => f.name === "scheduler_submit");
    expect(submitFactory).toBeDefined();

    const tool1 = (await submitFactory?.create(agent1)) as Tool;
    const tool2 = (await submitFactory?.create(agent2)) as Tool;

    await tool1.execute({ input: "from-1", mode: "spawn" });
    await tool2.execute({ input: "from-2", mode: "dispatch" });

    // Both submits should go through with their respective pinned agentIds
    const submitCalls = scheduler.calls.filter((c) => c.method === "submit");
    expect(submitCalls).toHaveLength(2);
    expect(submitCalls[0]?.args[0]).toBe(agentId("agent-1"));
    expect(submitCalls[1]?.args[0]).toBe(agentId("agent-2"));
  });

  test("operations filter restricts which tool factories are included", () => {
    const reg = createSchedulerRegistration({
      scheduler: stubScheduler(),
      operations: ["submit", "stats"],
    });

    expect(reg.tools).toHaveLength(2);
    expect(reg.tools[0]?.name).toBe("scheduler_submit");
    expect(reg.tools[1]?.name).toBe("scheduler_stats");
  });

  test("respects custom prefix", () => {
    const reg = createSchedulerRegistration({
      scheduler: stubScheduler(),
      prefix: "sched",
    });

    const names = reg.tools.map((f) => f.name);
    expect(names).toContain("sched_submit");
    expect(names).toContain("sched_cancel");
    expect(names).not.toContain("scheduler_submit");
  });
});
