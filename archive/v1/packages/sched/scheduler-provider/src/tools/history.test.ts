import { describe, expect, test } from "bun:test";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockSchedulerComponent } from "../test-helpers.js";
import { createHistoryTool } from "./history.js";

describe("createHistoryTool", () => {
  test("returns runs array on success", async () => {
    const component = createMockSchedulerComponent();
    const tool = createHistoryTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({})) as {
      readonly runs: readonly unknown[];
      readonly count: number;
    };

    expect(result.runs).toHaveLength(1);
    expect(result.count).toBe(1);
  });

  test("passes status filter to component", async () => {
    const component = createMockSchedulerComponent();
    const tool = createHistoryTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ status: "failed" });

    expect(component.calls).toHaveLength(1);
    expect(component.calls[0]?.method).toBe("history");
    const filter = component.calls[0]?.args?.[0] as Record<string, unknown>;
    expect(filter.status).toBe("failed");
  });

  test("passes since filter to component", async () => {
    const component = createMockSchedulerComponent();
    const tool = createHistoryTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY);
    const since = Date.now() - 60_000;
    await tool.execute({ since });

    expect(component.calls).toHaveLength(1);
    const filter = component.calls[0]?.args?.[0] as Record<string, unknown>;
    expect(filter.since).toBe(since);
  });

  test("clamps limit to max", async () => {
    const component = createMockSchedulerComponent();
    const tool = createHistoryTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY, 10, 5);
    await tool.execute({ limit: 100 });

    const filter = component.calls[0]?.args?.[0] as Record<string, unknown>;
    expect(filter.limit).toBe(10);
  });

  test("clamps limit to minimum of 1", async () => {
    const component = createMockSchedulerComponent();
    const tool = createHistoryTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY, 50, 20);
    await tool.execute({ limit: -5 });

    const filter = component.calls[0]?.args?.[0] as Record<string, unknown>;
    expect(filter.limit).toBe(1);
  });

  test("uses default limit when not specified", async () => {
    const component = createMockSchedulerComponent();
    const tool = createHistoryTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY, 50, 15);
    await tool.execute({});

    const filter = component.calls[0]?.args?.[0] as Record<string, unknown>;
    expect(filter.limit).toBe(15);
  });

  test("returns validation error for invalid status", async () => {
    const component = createMockSchedulerComponent();
    const tool = createHistoryTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ status: "running" })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("status");
  });

  test("handles component error gracefully", async () => {
    const component = {
      ...createMockSchedulerComponent(),
      history: () => {
        throw new Error("storage unavailable");
      },
    };
    const tool = createHistoryTool(component, "scheduler", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({})) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("INTERNAL");
  });

  test("descriptor has correct name", () => {
    const component = createMockSchedulerComponent();
    const tool = createHistoryTool(component, "sched", DEFAULT_SANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("sched_history");
  });
});
