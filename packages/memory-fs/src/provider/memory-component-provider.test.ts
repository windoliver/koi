import { describe, expect, test } from "bun:test";
import type { AttachResult, MemoryComponent, SkillComponent, Tool } from "@koi/core";
import { isAttachResult, MEMORY, skillToken, toolToken } from "@koi/core";
import { createMemoryProvider } from "./memory-component-provider.js";
import { createMockAgent, createMockFsMemory } from "./test-helpers.js";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

describe("createMemoryProvider — attach", () => {
  test("provider name is 'memory'", () => {
    const provider = createMemoryProvider({ memory: createMockFsMemory() });
    expect(provider.name).toBe("memory");
  });

  test("attaches all 3 tools + MEMORY token + skill = 5 entries", async () => {
    const provider = createMemoryProvider({ memory: createMockFsMemory() });
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.size).toBe(5);
    expect(components.has(toolToken("memory_store") as string)).toBe(true);
    expect(components.has(toolToken("memory_recall") as string)).toBe(true);
    expect(components.has(toolToken("memory_search") as string)).toBe(true);
    expect(components.has(MEMORY as string)).toBe(true);
    expect(components.has(skillToken("memory") as string)).toBe(true);
  });

  test("MEMORY token contains MemoryComponent with store/recall", async () => {
    const provider = createMemoryProvider({ memory: createMockFsMemory() });
    const components = extractMap(await provider.attach(createMockAgent()));

    const component = components.get(MEMORY as string) as MemoryComponent;
    expect(component).toBeDefined();
    expect(typeof component.store).toBe("function");
    expect(typeof component.recall).toBe("function");
  });

  test("skill token has correct content", async () => {
    const provider = createMemoryProvider({ memory: createMockFsMemory() });
    const components = extractMap(await provider.attach(createMockAgent()));

    const skill = components.get(skillToken("memory") as string) as SkillComponent;
    expect(skill).toBeDefined();
    expect(skill.name).toBe("memory");
    expect(skill.content).toContain("memory_store");
    expect(skill.content).toContain("memory_recall");
    expect(skill.content).toContain("memory_search");
  });

  test("respects custom prefix", async () => {
    const provider = createMemoryProvider({
      memory: createMockFsMemory(),
      prefix: "mem",
    });
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.has(toolToken("mem_store") as string)).toBe(true);
    expect(components.has(toolToken("mem_recall") as string)).toBe(true);
    expect(components.has(toolToken("mem_search") as string)).toBe(true);
    expect(components.has(toolToken("memory_store") as string)).toBe(false);
  });

  test("respects custom trust tier", async () => {
    const provider = createMemoryProvider({
      memory: createMockFsMemory(),
      trustTier: "sandbox",
    });
    const components = extractMap(await provider.attach(createMockAgent()));

    const tool = components.get(toolToken("memory_store") as string) as Tool;
    expect(tool.trustTier).toBe("sandbox");
  });

  test("respects operations subset", async () => {
    const provider = createMemoryProvider({
      memory: createMockFsMemory(),
      operations: ["store", "recall"],
    });
    const components = extractMap(await provider.attach(createMockAgent()));

    // 2 tools + MEMORY token + skill = 4
    expect(components.size).toBe(4);
    expect(components.has(toolToken("memory_store") as string)).toBe(true);
    expect(components.has(toolToken("memory_recall") as string)).toBe(true);
    expect(components.has(toolToken("memory_search") as string)).toBe(false);
  });

  test("custom skill content overrides default", async () => {
    const customContent = "Custom memory instructions";
    const provider = createMemoryProvider({
      memory: createMockFsMemory(),
      skillContent: customContent,
    });
    const components = extractMap(await provider.attach(createMockAgent()));

    const skill = components.get(skillToken("memory") as string) as SkillComponent;
    expect(skill.content).toBe(customContent);
  });
});

describe("createMemoryProvider — detach", () => {
  test("detach calls memory.close()", async () => {
    const memory = createMockFsMemory();
    const provider = createMemoryProvider({ memory });
    await provider.detach?.(createMockAgent());

    expect(memory.calls).toHaveLength(1);
    expect(memory.calls[0]?.method).toBe("close");
  });
});

describe("tool descriptors", () => {
  test("each tool has correct name and non-empty description", async () => {
    const provider = createMemoryProvider({ memory: createMockFsMemory() });
    const components = extractMap(await provider.attach(createMockAgent()));

    const expectedNames = ["memory_store", "memory_recall", "memory_search"];
    for (const name of expectedNames) {
      const tool = components.get(toolToken(name) as string) as Tool;
      expect(tool.descriptor.name).toBe(name);
      expect(tool.descriptor.description.length).toBeGreaterThan(0);
    }
  });
});
