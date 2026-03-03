import { describe, expect, test } from "bun:test";
import { createMockSchedulerComponent } from "../test-helpers.js";
import { createScheduleTool } from "./schedule.js";

describe("createScheduleTool", () => {
  test("returns scheduleId on success", async () => {
    const component = createMockSchedulerComponent();
    const tool = createScheduleTool(component, "scheduler", "verified");
    const result = (await tool.execute({
      expression: "0 0 * * *",
      input: "daily task",
      mode: "spawn",
    })) as { readonly scheduleId: string };

    expect(result.scheduleId).toBe("sch-1");
  });

  test("passes timezone and priority to component", async () => {
    const component = createMockSchedulerComponent();
    const tool = createScheduleTool(component, "scheduler", "verified");
    await tool.execute({
      expression: "0 9 * * 1-5",
      input: "weekday task",
      mode: "dispatch",
      timezone: "America/New_York",
      priority: 2,
    });

    expect(component.calls).toHaveLength(1);
    expect(component.calls[0]?.method).toBe("schedule");
    const args = component.calls[0]?.args;
    expect(args?.[0]).toBe("0 9 * * 1-5");
    expect(args?.[2]).toBe("dispatch");
    const options = args?.[3] as Record<string, unknown>;
    expect(options.timezone).toBe("America/New_York");
    expect(options.priority).toBe(2);
  });

  test("returns validation error when expression missing", async () => {
    const component = createMockSchedulerComponent();
    const tool = createScheduleTool(component, "scheduler", "verified");
    const result = (await tool.execute({ input: "x", mode: "spawn" })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("expression");
  });

  test("returns validation error when mode is invalid", async () => {
    const component = createMockSchedulerComponent();
    const tool = createScheduleTool(component, "scheduler", "verified");
    const result = (await tool.execute({
      expression: "* * * * *",
      input: "x",
      mode: "bad",
    })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("mode");
  });

  test("descriptor has correct name", () => {
    const component = createMockSchedulerComponent();
    const tool = createScheduleTool(component, "sched", "promoted");
    expect(tool.descriptor.name).toBe("sched_schedule");
    expect(tool.trustTier).toBe("promoted");
  });
});
