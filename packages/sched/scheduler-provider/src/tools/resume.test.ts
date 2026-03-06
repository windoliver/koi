import { describe, expect, test } from "bun:test";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockSchedulerComponent } from "../test-helpers.js";
import { createResumeTool } from "./resume.js";

describe("createResumeTool", () => {
  test("returns resumed: true on success", async () => {
    const component = createMockSchedulerComponent();
    const tool = createResumeTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ scheduleId: "sch-1" })) as {
      readonly resumed: boolean;
    };

    expect(result.resumed).toBe(true);
  });

  test("passes branded ScheduleId to component", async () => {
    const component = createMockSchedulerComponent();
    const tool = createResumeTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ scheduleId: "sch-42" });

    expect(component.calls).toHaveLength(1);
    expect(component.calls[0]?.method).toBe("resume");
    expect(component.calls[0]?.args?.[0] as string).toBe("sch-42");
  });

  test("returns validation error when scheduleId missing", async () => {
    const component = createMockSchedulerComponent();
    const tool = createResumeTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY);
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
      resume: () => {
        throw new Error("not found");
      },
    };
    const tool = createResumeTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ scheduleId: "sch-99" })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("INTERNAL");
  });

  test("descriptor has correct name", () => {
    const component = createMockSchedulerComponent();
    const tool = createResumeTool(component, "sched", DEFAULT_SANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("sched_resume");
  });
});
