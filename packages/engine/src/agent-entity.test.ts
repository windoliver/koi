import { describe, expect, test } from "bun:test";
import type { AgentManifest, ComponentProvider, ProcessId, Tool } from "@koi/core";
import { agentId, MEMORY, token, toolToken } from "@koi/core";
import { AgentEntity } from "./agent-entity.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testPid(overrides?: Partial<ProcessId>): ProcessId {
  return {
    id: agentId("test-001"),
    name: "test-agent",
    type: "copilot",
    depth: 0,
    ...overrides,
  };
}

function testManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    name: "Test Agent",
    version: "0.1.0",
    model: { name: "test-model" },
    ...overrides,
  };
}

function testTool(name: string): Tool {
  return {
    descriptor: { name, description: `${name} tool`, inputSchema: {} },
    trustTier: "sandbox",
    execute: async () => ({}),
  };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("AgentEntity constructor", () => {
  test("initializes with pid and manifest", () => {
    const pid = testPid();
    const manifest = testManifest();
    const agent = new AgentEntity(pid, manifest);
    expect(agent.pid).toBe(pid);
    expect(agent.manifest).toBe(manifest);
  });

  test("starts in created state", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    expect(agent.state).toBe("created");
  });
});

// ---------------------------------------------------------------------------
// Component access
// ---------------------------------------------------------------------------

describe("component access", () => {
  test("component returns undefined for missing token", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    expect(agent.component(token<unknown>("missing"))).toBeUndefined();
  });

  test("has returns false for missing token", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    expect(agent.has(token<unknown>("missing"))).toBe(false);
  });

  test("hasAll returns false when any token is missing", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    expect(agent.hasAll(token<unknown>("a"), token<unknown>("b"))).toBe(false);
  });

  test("hasAll returns true for empty args", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    expect(agent.hasAll()).toBe(true);
  });

  test("query returns empty map for missing prefix", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    const result = agent.query("nonexistent:");
    expect(result.size).toBe(0);
  });

  test("components returns empty map before assembly", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    expect(agent.components().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

describe("AgentEntity.assemble", () => {
  test("attaches components from providers", async () => {
    const provider: ComponentProvider = {
      name: "tool-provider",
      attach: async () => {
        const components = new Map<string, unknown>();
        components.set("tool:calc", testTool("calc"));
        components.set("tool:search", testTool("search"));
        return components;
      },
    };

    const agent = await AgentEntity.assemble(testPid(), testManifest(), [provider]);

    expect(agent.has(toolToken("calc"))).toBe(true);
    expect(agent.has(toolToken("search"))).toBe(true);
    expect(agent.components().size).toBe(2);
  });

  test("merges components from multiple providers", async () => {
    const provider1: ComponentProvider = {
      name: "tools",
      attach: async () => new Map([["tool:calc", testTool("calc")]]),
    };
    const provider2: ComponentProvider = {
      name: "memory",
      attach: async () => new Map([["memory", { recall: async () => [], store: async () => {} }]]),
    };

    const agent = await AgentEntity.assemble(testPid(), testManifest(), [provider1, provider2]);

    expect(agent.has(toolToken("calc"))).toBe(true);
    expect(agent.has(MEMORY)).toBe(true);
    expect(agent.components().size).toBe(2);
  });

  test("later provider overwrites earlier for same key", async () => {
    const tool1 = testTool("v1");
    const tool2 = testTool("v2");
    const provider1: ComponentProvider = {
      name: "first",
      attach: async () => new Map([["tool:calc", tool1]]),
    };
    const provider2: ComponentProvider = {
      name: "second",
      attach: async () => new Map([["tool:calc", tool2]]),
    };

    const agent = await AgentEntity.assemble(testPid(), testManifest(), [provider1, provider2]);

    const result = agent.component<Tool>(toolToken("calc"));
    expect(result?.descriptor.name).toBe("v2");
  });

  test("empty providers results in empty components", async () => {
    const agent = await AgentEntity.assemble(testPid(), testManifest(), []);
    expect(agent.components().size).toBe(0);
  });

  test("component retrieves typed value", async () => {
    const calc = testTool("calc");
    const provider: ComponentProvider = {
      name: "tools",
      attach: async () => new Map([["tool:calc", calc]]),
    };

    const agent = await AgentEntity.assemble(testPid(), testManifest(), [provider]);
    const retrieved = agent.component<Tool>(toolToken("calc"));
    expect(retrieved).toBe(calc);
  });
});

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

describe("query", () => {
  test("returns all components matching prefix", async () => {
    const provider: ComponentProvider = {
      name: "mixed",
      attach: async () =>
        new Map<string, unknown>([
          ["tool:calc", testTool("calc")],
          ["tool:search", testTool("search")],
          ["memory", { recall: async () => [], store: async () => {} }],
          ["channel:telegram", { name: "telegram" }],
        ]),
    };

    const agent = await AgentEntity.assemble(testPid(), testManifest(), [provider]);

    const tools = agent.query<Tool>("tool:");
    expect(tools.size).toBe(2);

    const channels = agent.query("channel:");
    expect(channels.size).toBe(1);

    // No components with "skill:" prefix
    const skills = agent.query("skill:");
    expect(skills.size).toBe(0);
  });

  test("returns cached result on repeated calls (same reference)", async () => {
    const provider: ComponentProvider = {
      name: "tools",
      attach: async () =>
        new Map<string, unknown>([
          ["tool:calc", testTool("calc")],
          ["tool:search", testTool("search")],
        ]),
    };

    const agent = await AgentEntity.assemble(testPid(), testManifest(), [provider]);
    const first = agent.query<Tool>("tool:");
    const second = agent.query<Tool>("tool:");
    expect(first).toBe(second); // Same reference = cache hit
    expect(first.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// hasAll
// ---------------------------------------------------------------------------

describe("hasAll with assembled components", () => {
  test("returns true when all tokens present", async () => {
    const provider: ComponentProvider = {
      name: "provider",
      attach: async () =>
        new Map<string, unknown>([
          ["tool:calc", testTool("calc")],
          ["memory", {}],
        ]),
    };
    const agent = await AgentEntity.assemble(testPid(), testManifest(), [provider]);
    expect(agent.hasAll(toolToken("calc"), MEMORY)).toBe(true);
  });

  test("returns false when one token missing", async () => {
    const provider: ComponentProvider = {
      name: "provider",
      attach: async () => new Map([["tool:calc", testTool("calc")]]),
    };
    const agent = await AgentEntity.assemble(testPid(), testManifest(), [provider]);
    expect(agent.hasAll(toolToken("calc"), MEMORY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

describe("lifecycle transitions", () => {
  test("transition changes state", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    expect(agent.state).toBe("created");

    agent.transition({ kind: "start" });
    expect(agent.state).toBe("running");
  });

  test("full lifecycle: created → running → terminated", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    agent.transition({ kind: "start" });
    agent.transition({ kind: "complete", stopReason: "completed" });
    expect(agent.state).toBe("terminated");
  });

  test("lifecycle property returns current state", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    expect(agent.lifecycle.state).toBe("created");
    agent.transition({ kind: "start" });
    expect(agent.lifecycle.state).toBe("running");
  });
});
