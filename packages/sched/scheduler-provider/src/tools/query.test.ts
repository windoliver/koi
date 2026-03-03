import { describe, expect, test } from "bun:test";
import type { TaskFilter } from "@koi/core";
import { DEFAULT_QUERY_DEFAULT } from "../constants.js";
import { createMockSchedulerComponent } from "../test-helpers.js";
import { createQueryTool } from "./query.js";

describe("createQueryTool", () => {
  test("returns tasks and count on success", async () => {
    const component = createMockSchedulerComponent();
    const tool = createQueryTool(component, "scheduler", "verified");
    const result = (await tool.execute({})) as {
      readonly tasks: readonly unknown[];
      readonly count: number;
    };

    expect(result.count).toBe(1);
    expect(result.tasks).toHaveLength(1);
  });

  test("passes status filter to component", async () => {
    const component = createMockSchedulerComponent();
    const tool = createQueryTool(component, "scheduler", "verified");
    await tool.execute({ status: "pending" });

    expect(component.calls).toHaveLength(1);
    const filter = component.calls[0]?.args?.[0] as TaskFilter;
    expect(filter.status).toBe("pending");
  });

  test("passes priority filter to component", async () => {
    const component = createMockSchedulerComponent();
    const tool = createQueryTool(component, "scheduler", "verified");
    await tool.execute({ priority: 1 });

    const filter = component.calls[0]?.args?.[0] as TaskFilter;
    expect(filter.priority).toBe(1);
  });

  test("uses default limit when not specified", async () => {
    const component = createMockSchedulerComponent();
    const tool = createQueryTool(component, "scheduler", "verified");
    await tool.execute({});

    const filter = component.calls[0]?.args?.[0] as TaskFilter;
    expect(filter.limit).toBe(DEFAULT_QUERY_DEFAULT);
  });

  test("clamps limit to max", async () => {
    const component = createMockSchedulerComponent();
    const tool = createQueryTool(component, "scheduler", "verified", 50, 20);
    await tool.execute({ limit: 999 });

    const filter = component.calls[0]?.args?.[0] as TaskFilter;
    expect(filter.limit).toBe(50);
  });

  test("clamps limit to minimum 1", async () => {
    const component = createMockSchedulerComponent();
    const tool = createQueryTool(component, "scheduler", "verified");
    await tool.execute({ limit: -5 });

    const filter = component.calls[0]?.args?.[0] as TaskFilter;
    expect(filter.limit).toBe(1);
  });

  test("respects custom query limits", async () => {
    const component = createMockSchedulerComponent();
    const tool = createQueryTool(component, "scheduler", "verified", 10, 5);
    await tool.execute({});

    const filter = component.calls[0]?.args?.[0] as TaskFilter;
    expect(filter.limit).toBe(5);
  });

  test("returns validation error for invalid status", async () => {
    const component = createMockSchedulerComponent();
    const tool = createQueryTool(component, "scheduler", "verified");
    const result = (await tool.execute({ status: "invalid" })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("status");
  });

  test("descriptor includes max limit in description", () => {
    const component = createMockSchedulerComponent();
    const tool = createQueryTool(component, "scheduler", "verified", 25);
    expect(tool.descriptor.description).toContain("25");
  });
});
