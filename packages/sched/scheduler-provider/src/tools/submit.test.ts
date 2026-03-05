import { describe, expect, test } from "bun:test";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockSchedulerComponent } from "../test-helpers.js";
import { createSubmitTool } from "./submit.js";

describe("createSubmitTool", () => {
  test("returns taskId on success", async () => {
    const component = createMockSchedulerComponent();
    const tool = createSubmitTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ input: "do something", mode: "spawn" })) as {
      readonly taskId: string;
    };

    expect(result.taskId).toBe("task-1");
  });

  test("passes input and mode to component", async () => {
    const component = createMockSchedulerComponent();
    const tool = createSubmitTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ input: "hello", mode: "dispatch" });

    expect(component.calls).toHaveLength(1);
    expect(component.calls[0]?.method).toBe("submit");
    const args = component.calls[0]?.args;
    expect(args?.[1] as string).toBe("dispatch");
  });

  test("passes optional task options", async () => {
    const component = createMockSchedulerComponent();
    const tool = createSubmitTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({
      input: "task",
      mode: "spawn",
      priority: 1,
      delayMs: 5000,
      maxRetries: 5,
      timeoutMs: 30000,
    });

    const options = component.calls[0]?.args?.[2] as Record<string, unknown>;
    expect(options.priority).toBe(1);
    expect(options.delayMs).toBe(5000);
    expect(options.maxRetries).toBe(5);
    expect(options.timeoutMs).toBe(30000);
  });

  test("returns validation error when mode is invalid", async () => {
    const component = createMockSchedulerComponent();
    const tool = createSubmitTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ input: "x", mode: "invalid" })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("mode");
  });

  test("descriptor has correct name and schema", () => {
    const component = createMockSchedulerComponent();
    const tool = createSubmitTool(component, "sched", DEFAULT_SANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("sched_submit");
    expect(tool.policy.sandbox).toBe(true);

    const schema = tool.descriptor.inputSchema as Record<string, unknown>;
    const required = schema.required as readonly string[];
    expect(required).toContain("input");
    expect(required).toContain("mode");
  });

  test("handles component error gracefully", async () => {
    const component = {
      ...createMockSchedulerComponent(),
      submit: () => {
        throw new Error("scheduler unavailable");
      },
    };
    const tool = createSubmitTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ input: "x", mode: "spawn" })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("INTERNAL");
    expect(result.error).toContain("scheduler unavailable");
  });
});
