import { describe, expect, test } from "bun:test";
import type { Agent, ProcessId, ProcessState } from "@koi/core";
import { createAceToolsProvider } from "./ace-tools-provider.js";
import { createInMemoryPlaybookStore, createInMemoryStructuredPlaybookStore } from "./stores.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides?: Partial<ProcessId>): Agent {
  const pid: ProcessId = {
    id: "agent-1" as ProcessId["id"],
    name: "test-agent",
    type: "copilot",
    depth: 0,
    ...overrides,
  } as ProcessId;

  return {
    pid,
    manifest: {} as Agent["manifest"],
    state: "running" as ProcessState,
    component: () => undefined,
    has: () => false,
    query: () => new Map(),
    components: () => new Map(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAceToolsProvider", () => {
  test("returns a ComponentProvider with correct name and priority", () => {
    const provider = createAceToolsProvider({
      playbookStore: createInMemoryPlaybookStore(),
    });

    expect(provider.name).toBe("ace-tools");
    expect(provider.priority).toBe(60);
  });

  test("attaches list_playbooks tool and self-forge skill", async () => {
    const provider = createAceToolsProvider({
      playbookStore: createInMemoryPlaybookStore(),
    });

    const components = await provider.attach(makeAgent());
    expect(components).toBeInstanceOf(Map);

    const map = components as Map<string, unknown>;
    expect(map.has("tool:list_playbooks")).toBe(true);
    expect(map.has("skill:ace-self-forge")).toBe(true);
    expect(map.size).toBe(2);
  });

  test("list_playbooks tool is executable", async () => {
    const playbookStore = createInMemoryPlaybookStore();
    await playbookStore.save({
      id: "pb-1",
      title: "Test",
      strategy: "Do stuff",
      tags: ["test"],
      confidence: 0.9,
      source: "curated",
      createdAt: 1000,
      updatedAt: 1000,
      sessionCount: 3,
    });

    const provider = createAceToolsProvider({ playbookStore });
    const components = (await provider.attach(makeAgent())) as Map<string, unknown>;
    const tool = components.get("tool:list_playbooks") as {
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    };

    const result = (await tool.execute({})) as { count: number };
    expect(result.count).toBe(1);
  });

  test("passes structured store to tool when provided", async () => {
    const structuredStore = createInMemoryStructuredPlaybookStore();
    await structuredStore.save({
      id: "sp-1",
      title: "Structured",
      sections: [],
      tags: [],
      source: "curated",
      createdAt: 1000,
      updatedAt: 1000,
      sessionCount: 1,
    });

    const provider = createAceToolsProvider({
      playbookStore: createInMemoryPlaybookStore(),
      structuredPlaybookStore: structuredStore,
    });

    const components = (await provider.attach(makeAgent())) as Map<string, unknown>;
    const tool = components.get("tool:list_playbooks") as {
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    };

    const result = (await tool.execute({})) as { kind: string };
    expect(result.kind).toBe("structured");
  });

  test("self-forge skill has correct content", async () => {
    const provider = createAceToolsProvider({
      playbookStore: createInMemoryPlaybookStore(),
    });

    const components = (await provider.attach(makeAgent())) as Map<string, unknown>;
    const skill = components.get("skill:ace-self-forge") as {
      name: string;
      content: string;
      tags: readonly string[];
    };

    expect(skill.name).toBe("ace-self-forge");
    expect(skill.content).toContain("list_playbooks");
    expect(skill.content).toContain("forge_skill");
    expect(skill.tags).toContain("ace");
  });
});
