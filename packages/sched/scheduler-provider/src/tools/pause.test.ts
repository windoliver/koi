import { describe, expect, test } from "bun:test";
import { createMockSchedulerComponent } from "../test-helpers.js";
import { createPauseTool } from "./pause.js";

describe("createPauseTool", () => {
  test("returns paused: true on success", async () => {
    const component = createMockSchedulerComponent();
    const tool = createPauseTool(component, "scheduler", "verified");
    const result = (await tool.execute({ scheduleId: "sch-1" })) as {
      readonly paused: boolean;
    };

    expect(result.paused).toBe(true);
  });

  test("passes branded ScheduleId to component", async () => {
    const component = createMockSchedulerComponent();
    const tool = createPauseTool(component, "scheduler", "verified");
    await tool.execute({ scheduleId: "sch-42" });

    expect(component.calls).toHaveLength(1);
    expect(component.calls[0]?.method).toBe("pause");
    expect(component.calls[0]?.args?.[0] as string).toBe("sch-42");
  });

  test("returns validation error when scheduleId missing", async () => {
    const component = createMockSchedulerComponent();
    const tool = createPauseTool(component, "scheduler", "verified");
    const result = (await tool.execute({})) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("scheduleId");
  });

  test("handles component error gracefully", async () => {
    const component = {
      ...createMockSchedulerComponent(),
      pause: () => {
        throw new Error("not found");
      },
    };
    const tool = createPauseTool(component, "scheduler", "verified");
    const result = (await tool.execute({ scheduleId: "sch-99" })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("INTERNAL");
  });

  test("descriptor has correct name", () => {
    const component = createMockSchedulerComponent();
    const tool = createPauseTool(component, "sched", "sandbox");
    expect(tool.descriptor.name).toBe("sched_pause");
  });
});
