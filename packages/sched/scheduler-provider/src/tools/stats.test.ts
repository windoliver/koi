import { describe, expect, test } from "bun:test";
import type { SchedulerStats } from "@koi/core";
import { createMockSchedulerComponent } from "../test-helpers.js";
import { createStatsTool } from "./stats.js";

describe("createStatsTool", () => {
  test("returns scheduler stats", async () => {
    const component = createMockSchedulerComponent();
    const tool = createStatsTool(component, "scheduler", "verified");
    const result = (await tool.execute({})) as SchedulerStats;

    expect(result.pending).toBe(1);
    expect(result.running).toBe(0);
    expect(result.completed).toBe(5);
    expect(result.failed).toBe(0);
    expect(result.deadLettered).toBe(0);
    expect(result.activeSchedules).toBe(2);
  });

  test("handles component error gracefully", async () => {
    const component = {
      ...createMockSchedulerComponent(),
      stats: () => {
        throw new Error("stats unavailable");
      },
    };
    const tool = createStatsTool(component, "scheduler", "verified");
    const result = (await tool.execute({})) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("INTERNAL");
    expect(result.error).toContain("stats unavailable");
  });

  test("descriptor has correct name and empty required", () => {
    const component = createMockSchedulerComponent();
    const tool = createStatsTool(component, "sched", "sandbox");
    expect(tool.descriptor.name).toBe("sched_stats");
    expect(tool.trustTier).toBe("sandbox");

    const schema = tool.descriptor.inputSchema as Record<string, unknown>;
    const required = schema.required as readonly string[];
    expect(required).toHaveLength(0);
  });
});
