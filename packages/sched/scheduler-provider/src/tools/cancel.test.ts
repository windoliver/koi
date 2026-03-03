import { describe, expect, test } from "bun:test";
import { createMockSchedulerComponent } from "../test-helpers.js";
import { createCancelTool } from "./cancel.js";

describe("createCancelTool", () => {
  test("returns cancelled: true on success", async () => {
    const component = createMockSchedulerComponent();
    const tool = createCancelTool(component, "scheduler", "verified");
    const result = (await tool.execute({ taskId: "task-1" })) as {
      readonly cancelled: boolean;
    };

    expect(result.cancelled).toBe(true);
  });

  test("passes branded TaskId to component", async () => {
    const component = createMockSchedulerComponent();
    const tool = createCancelTool(component, "scheduler", "verified");
    await tool.execute({ taskId: "task-42" });

    expect(component.calls).toHaveLength(1);
    expect(component.calls[0]?.method).toBe("cancel");
    expect(component.calls[0]?.args?.[0] as string).toBe("task-42");
  });

  test("returns validation error when taskId missing", async () => {
    const component = createMockSchedulerComponent();
    const tool = createCancelTool(component, "scheduler", "verified");
    const result = (await tool.execute({})) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("taskId");
  });

  test("handles component error gracefully", async () => {
    const component = {
      ...createMockSchedulerComponent(),
      cancel: () => {
        throw new Error("not found");
      },
    };
    const tool = createCancelTool(component, "scheduler", "verified");
    const result = (await tool.execute({ taskId: "task-99" })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("INTERNAL");
    expect(result.error).toContain("not found");
  });

  test("descriptor has correct name", () => {
    const component = createMockSchedulerComponent();
    const tool = createCancelTool(component, "sched", "sandbox");
    expect(tool.descriptor.name).toBe("sched_cancel");
  });
});
