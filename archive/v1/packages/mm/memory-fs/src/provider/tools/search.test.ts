import { describe, expect, test } from "bun:test";
import type { MemoryRecallOptions } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockFsMemory, createMockMemoryComponent } from "../test-helpers.js";
import { createMemorySearchTool } from "./search.js";

describe("createMemorySearchTool", () => {
  test("returns results when entity is provided", async () => {
    const component = createMockMemoryComponent();
    const memory = createMockFsMemory(component);
    const tool = createMemorySearchTool(memory, "memory", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ entity: "alice" })) as {
      readonly results: readonly unknown[];
      readonly count: number;
    };

    expect(result.count).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(component.calls).toHaveLength(1);
    expect(component.calls[0]?.method).toBe("recall");
    expect(component.calls[0]?.args?.[0]).toBe("alice");
    const opts = component.calls[0]?.args?.[1] as MemoryRecallOptions;
    expect(opts.namespace).toBe("alice");
  });

  test("returns entity list when no entity provided", async () => {
    const memory = createMockFsMemory();
    const tool = createMemorySearchTool(memory, "memory", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({})) as {
      readonly entities: readonly string[];
    };

    expect(result.entities).toEqual(["alice", "bob", "project-x"]);
    expect(memory.calls).toHaveLength(1);
    expect(memory.calls[0]?.method).toBe("listEntities");
  });

  test("respects custom limit for entity search", async () => {
    const component = createMockMemoryComponent();
    const memory = createMockFsMemory(component);
    const tool = createMemorySearchTool(memory, "memory", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ entity: "alice", limit: 5 });

    const opts = component.calls[0]?.args?.[1] as MemoryRecallOptions;
    expect(opts.limit).toBe(5);
  });

  test("clamps limit to max", async () => {
    const component = createMockMemoryComponent();
    const memory = createMockFsMemory(component);
    const tool = createMemorySearchTool(memory, "memory", DEFAULT_UNSANDBOXED_POLICY, 20);
    await tool.execute({ entity: "alice", limit: 999 });

    const opts = component.calls[0]?.args?.[1] as MemoryRecallOptions;
    expect(opts.limit).toBe(20);
  });

  test("handles component error gracefully", async () => {
    const component = {
      ...createMockMemoryComponent(),
      recall: () => {
        throw new Error("disk error");
      },
    };
    const memory = createMockFsMemory(component);
    const tool = createMemorySearchTool(memory, "memory", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({ entity: "alice" })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("INTERNAL");
    expect(result.error).toContain("disk error");
  });

  test("handles listEntities error gracefully", async () => {
    const memory = {
      ...createMockFsMemory(),
      listEntities: () => {
        throw new Error("fs error");
      },
    };
    const tool = createMemorySearchTool(memory, "memory", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({})) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("INTERNAL");
    expect(result.error).toContain("fs error");
  });

  test("descriptor has correct name", () => {
    const memory = createMockFsMemory();
    const tool = createMemorySearchTool(memory, "mem", DEFAULT_SANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("mem_search");
  });
});
