import { describe, expect, test } from "bun:test";
import type { MemoryStoreOptions } from "@koi/core";
import { createMockMemoryComponent } from "../test-helpers.js";
import { createMemoryStoreTool } from "./store.js";

describe("createMemoryStoreTool", () => {
  test("stores fact with correct options", async () => {
    const component = createMockMemoryComponent();
    const tool = createMemoryStoreTool(component, "memory", "verified");
    const result = (await tool.execute({
      content: "User prefers dark mode",
      category: "preference",
      related_entities: ["alice"],
    })) as { readonly stored: boolean };

    expect(result.stored).toBe(true);
    expect(component.calls).toHaveLength(1);
    expect(component.calls[0]?.method).toBe("store");
    expect(component.calls[0]?.args?.[0]).toBe("User prefers dark mode");
    const opts = component.calls[0]?.args?.[1] as MemoryStoreOptions;
    expect(opts.category).toBe("preference");
    expect(opts.relatedEntities).toEqual(["alice"]);
  });

  test("stores fact with no optional fields", async () => {
    const component = createMockMemoryComponent();
    const tool = createMemoryStoreTool(component, "memory", "verified");
    const result = (await tool.execute({
      content: "Simple fact",
    })) as { readonly stored: boolean };

    expect(result.stored).toBe(true);
    expect(component.calls).toHaveLength(1);
    const opts = component.calls[0]?.args?.[1] as MemoryStoreOptions;
    expect(opts.category).toBeUndefined();
    expect(opts.relatedEntities).toBeUndefined();
  });

  test("returns validation error when content missing", async () => {
    const component = createMockMemoryComponent();
    const tool = createMemoryStoreTool(component, "memory", "verified");
    const result = (await tool.execute({})) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("content");
  });

  test("returns validation error when content is empty string", async () => {
    const component = createMockMemoryComponent();
    const tool = createMemoryStoreTool(component, "memory", "verified");
    const result = (await tool.execute({ content: "" })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error when related_entities is not array", async () => {
    const component = createMockMemoryComponent();
    const tool = createMemoryStoreTool(component, "memory", "verified");
    const result = (await tool.execute({
      content: "fact",
      related_entities: "not-an-array",
    })) as { readonly error: string; readonly code: string };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("related_entities");
  });

  test("handles component error gracefully", async () => {
    const component = {
      ...createMockMemoryComponent(),
      store: () => {
        throw new Error("disk full");
      },
    };
    const tool = createMemoryStoreTool(component, "memory", "verified");
    const result = (await tool.execute({ content: "fact" })) as {
      readonly error: string;
      readonly code: string;
    };

    expect(result.code).toBe("INTERNAL");
    expect(result.error).toContain("disk full");
  });

  test("descriptor has correct name with prefix", () => {
    const component = createMockMemoryComponent();
    const tool = createMemoryStoreTool(component, "mem", "sandbox");
    expect(tool.descriptor.name).toBe("mem_store");
    expect(tool.trustTier).toBe("sandbox");
  });
});
