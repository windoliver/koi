import { describe, expect, test } from "bun:test";
import type { MemoryRecallOptions } from "@koi/core";
import { createMockMemoryComponent } from "../test-helpers.js";
import { createMemoryRecallTool } from "./recall.js";

describe("createMemoryRecallTool", () => {
  test("returns results for valid query", async () => {
    const component = createMockMemoryComponent();
    const tool = createMemoryRecallTool(component, "memory", "verified");
    const result = (await tool.execute({ query: "dark mode" })) as {
      readonly results: readonly unknown[];
      readonly count: number;
    };

    expect(result.count).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(component.calls).toHaveLength(1);
    expect(component.calls[0]?.method).toBe("recall");
  });

  test("uses default limit of 10", async () => {
    const component = createMockMemoryComponent();
    const tool = createMemoryRecallTool(component, "memory", "verified");
    await tool.execute({ query: "test" });

    const opts = component.calls[0]?.args?.[1] as MemoryRecallOptions;
    expect(opts.limit).toBe(10);
  });

  test("respects custom limit", async () => {
    const component = createMockMemoryComponent();
    const tool = createMemoryRecallTool(component, "memory", "verified");
    await tool.execute({ query: "test", limit: 5 });

    const opts = component.calls[0]?.args?.[1] as MemoryRecallOptions;
    expect(opts.limit).toBe(5);
  });

  test("clamps limit to max", async () => {
    const component = createMockMemoryComponent();
    const tool = createMemoryRecallTool(component, "memory", "verified", 10);
    await tool.execute({ query: "test", limit: 999 });

    const opts = component.calls[0]?.args?.[1] as MemoryRecallOptions;
    expect(opts.limit).toBe(10);
  });

  test("passes tier filter when specified", async () => {
    const component = createMockMemoryComponent();
    const tool = createMemoryRecallTool(component, "memory", "verified");
    await tool.execute({ query: "test", tier: "hot" });

    const opts = component.calls[0]?.args?.[1] as MemoryRecallOptions;
    expect(opts.tierFilter).toBe("hot");
  });

  test("omits tierFilter when not specified", async () => {
    const component = createMockMemoryComponent();
    const tool = createMemoryRecallTool(component, "memory", "verified");
    await tool.execute({ query: "test" });

    const opts = component.calls[0]?.args?.[1] as MemoryRecallOptions;
    expect(opts.tierFilter).toBeUndefined();
  });

  test("returns validation error when query missing", async () => {
    const component = createMockMemoryComponent();
    const tool = createMemoryRecallTool(component, "memory", "verified");
    const result = (await tool.execute({})) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("query");
  });

  test("returns validation error for invalid tier", async () => {
    const component = createMockMemoryComponent();
    const tool = createMemoryRecallTool(component, "memory", "verified");
    const result = (await tool.execute({
      query: "test",
      tier: "invalid",
    })) as { readonly error: string; readonly code: string };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("tier");
  });

  test("handles component error gracefully", async () => {
    const component = {
      ...createMockMemoryComponent(),
      recall: () => {
        throw new Error("index corrupted");
      },
    };
    const tool = createMemoryRecallTool(component, "memory", "verified");
    const result = (await tool.execute({ query: "test" })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("INTERNAL");
    expect(result.error).toContain("index corrupted");
  });

  test("descriptor has correct name", () => {
    const component = createMockMemoryComponent();
    const tool = createMemoryRecallTool(component, "mem", "sandbox");
    expect(tool.descriptor.name).toBe("mem_recall");
  });
});
