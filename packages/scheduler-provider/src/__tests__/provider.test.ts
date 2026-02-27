import { describe, expect, test } from "bun:test";
import type { AttachResult, SchedulerComponent, TaskScheduler, Tool } from "@koi/core";
import { agentId, isAttachResult, SCHEDULER, scheduleId, taskId, toolToken } from "@koi/core";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

import { createSchedulerProvider } from "../scheduler-component-provider.js";
import { createMockAgent } from "../test-helpers.js";

/** Stub TaskScheduler that satisfies the full interface. */
function createMockTaskScheduler(): TaskScheduler {
  return {
    submit: () => taskId("task-1"),
    cancel: () => true,
    schedule: () => scheduleId("sched-1"),
    unschedule: () => true,
    pause: () => true,
    resume: () => true,
    query: () => [],
    stats: () => ({
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      deadLettered: 0,
      activeSchedules: 0,
      pausedSchedules: 0,
    }),
    history: () => [],
    watch: () => () => {},
    [Symbol.asyncDispose]: async () => {},
  };
}

describe("createSchedulerProvider — attach", () => {
  test("provider name is 'scheduler'", () => {
    const provider = createSchedulerProvider({ scheduler: createMockTaskScheduler() });
    expect(provider.name).toBe("scheduler");
  });

  test("attaches all 9 tools by default", async () => {
    const provider = createSchedulerProvider({ scheduler: createMockTaskScheduler() });
    const components = extractMap(await provider.attach(createMockAgent()));

    // 9 tools + SCHEDULER token
    expect(components.size).toBe(10);
    expect(components.has(toolToken("scheduler_submit") as string)).toBe(true);
    expect(components.has(toolToken("scheduler_cancel") as string)).toBe(true);
    expect(components.has(toolToken("scheduler_schedule") as string)).toBe(true);
    expect(components.has(toolToken("scheduler_unschedule") as string)).toBe(true);
    expect(components.has(toolToken("scheduler_query") as string)).toBe(true);
    expect(components.has(toolToken("scheduler_stats") as string)).toBe(true);
    expect(components.has(toolToken("scheduler_pause") as string)).toBe(true);
    expect(components.has(toolToken("scheduler_resume") as string)).toBe(true);
    expect(components.has(toolToken("scheduler_history") as string)).toBe(true);
  });

  test("attaches the component under SCHEDULER token", async () => {
    const provider = createSchedulerProvider({ scheduler: createMockTaskScheduler() });
    const components = extractMap(await provider.attach(createMockAgent()));

    const component = components.get(SCHEDULER as string) as SchedulerComponent;
    expect(component).toBeDefined();
    expect(typeof component.submit).toBe("function");
    expect(typeof component.cancel).toBe("function");
    expect(typeof component.stats).toBe("function");
  });

  test("respects custom prefix", async () => {
    const provider = createSchedulerProvider({
      scheduler: createMockTaskScheduler(),
      prefix: "sched",
    });
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.has(toolToken("sched_submit") as string)).toBe(true);
    expect(components.has(toolToken("sched_cancel") as string)).toBe(true);
    expect(components.has(toolToken("scheduler_submit") as string)).toBe(false);
  });

  test("respects custom trust tier", async () => {
    const provider = createSchedulerProvider({
      scheduler: createMockTaskScheduler(),
      trustTier: "sandbox",
    });
    const components = extractMap(await provider.attach(createMockAgent()));

    const tool = components.get(toolToken("scheduler_submit") as string) as Tool;
    expect(tool.trustTier).toBe("sandbox");
  });

  test("respects operations filter", async () => {
    const provider = createSchedulerProvider({
      scheduler: createMockTaskScheduler(),
      operations: ["submit", "stats"],
    });
    const components = extractMap(await provider.attach(createMockAgent()));

    // 2 tools + SCHEDULER token
    expect(components.size).toBe(3);
    expect(components.has(toolToken("scheduler_submit") as string)).toBe(true);
    expect(components.has(toolToken("scheduler_stats") as string)).toBe(true);
    expect(components.has(toolToken("scheduler_cancel") as string)).toBe(false);
  });

  test("creates per-agent component with pinned agentId", async () => {
    const provider = createSchedulerProvider({ scheduler: createMockTaskScheduler() });

    const agent1 = createMockAgent({
      pid: { id: agentId("agent-1") },
      manifest: { name: "agent-1" },
    });
    const agent2 = createMockAgent({
      pid: { id: agentId("agent-2") },
      manifest: { name: "agent-2" },
    });

    const components1 = extractMap(await provider.attach(agent1));
    const components2 = extractMap(await provider.attach(agent2));

    // Different component instances
    const comp1 = components1.get(SCHEDULER as string);
    const comp2 = components2.get(SCHEDULER as string);
    expect(comp1).not.toBe(comp2);
  });
});

describe("createSchedulerProvider — detach", () => {
  test("detach does not throw", async () => {
    const provider = createSchedulerProvider({ scheduler: createMockTaskScheduler() });
    await provider.detach?.(createMockAgent());
  });
});

describe("tool descriptors", () => {
  test("each tool has correct name and non-empty description", async () => {
    const provider = createSchedulerProvider({ scheduler: createMockTaskScheduler() });
    const components = extractMap(await provider.attach(createMockAgent()));

    const expectedNames = [
      "scheduler_submit",
      "scheduler_cancel",
      "scheduler_schedule",
      "scheduler_unschedule",
      "scheduler_query",
      "scheduler_stats",
      "scheduler_pause",
      "scheduler_resume",
      "scheduler_history",
    ];
    for (const name of expectedNames) {
      const tool = components.get(toolToken(name) as string) as Tool;
      expect(tool.descriptor.name).toBe(name);
      expect(tool.descriptor.description.length).toBeGreaterThan(0);
    }
  });
});
