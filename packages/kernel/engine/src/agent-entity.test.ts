import { describe, expect, test } from "bun:test";
import type { AgentManifest, ComponentProvider, ProcessId, Tool } from "@koi/core";
import {
  agentId,
  COMPONENT_PRIORITY,
  DEFAULT_SANDBOXED_POLICY,
  MEMORY,
  token,
  toolToken,
} from "@koi/core";
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
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
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

    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [provider]);

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

    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [provider1, provider2]);

    expect(agent.has(toolToken("calc"))).toBe(true);
    expect(agent.has(MEMORY)).toBe(true);
    expect(agent.components().size).toBe(2);
  });

  test("higher-priority provider wins (first-write-wins after sort)", async () => {
    const tool1 = testTool("v1");
    const tool2 = testTool("v2");
    const provider1: ComponentProvider = {
      name: "bundled",
      priority: COMPONENT_PRIORITY.BUNDLED,
      attach: async () => new Map([["tool:calc", tool1]]),
    };
    const provider2: ComponentProvider = {
      name: "forge",
      priority: COMPONENT_PRIORITY.AGENT_FORGED,
      attach: async () => new Map([["tool:calc", tool2]]),
    };

    // provider1 registered first, but provider2 has higher priority (lower number)
    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [provider1, provider2]);

    const result = agent.component<Tool>(toolToken("calc"));
    expect(result?.descriptor.name).toBe("v2");
  });

  test("same-priority ties broken by registration order (stable sort)", async () => {
    const tool1 = testTool("first");
    const tool2 = testTool("second");
    const provider1: ComponentProvider = {
      name: "first",
      priority: 50,
      attach: async () => new Map([["tool:calc", tool1]]),
    };
    const provider2: ComponentProvider = {
      name: "second",
      priority: 50,
      attach: async () => new Map([["tool:calc", tool2]]),
    };

    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [provider1, provider2]);

    // first-write-wins: provider1 comes first at same priority
    const result = agent.component<Tool>(toolToken("calc"));
    expect(result?.descriptor.name).toBe("first");
  });

  test("default priority is BUNDLED (100)", async () => {
    const tool1 = testTool("no-priority");
    const tool2 = testTool("forged");
    const provider1: ComponentProvider = {
      name: "no-priority",
      // no priority set — defaults to BUNDLED (100)
      attach: async () => new Map([["tool:calc", tool1]]),
    };
    const provider2: ComponentProvider = {
      name: "forged",
      priority: COMPONENT_PRIORITY.AGENT_FORGED,
      attach: async () => new Map([["tool:calc", tool2]]),
    };

    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [provider1, provider2]);

    // forged (priority 0) beats unset (defaults to 100)
    const result = agent.component<Tool>(toolToken("calc"));
    expect(result?.descriptor.name).toBe("forged");
  });

  test("returns empty conflicts when no key collisions", async () => {
    const provider1: ComponentProvider = {
      name: "tools",
      attach: async () => new Map([["tool:calc", testTool("calc")]]),
    };
    const provider2: ComponentProvider = {
      name: "memory",
      attach: async () => new Map([["memory", { recall: async () => [], store: async () => {} }]]),
    };

    const { conflicts } = await AgentEntity.assemble(testPid(), testManifest(), [
      provider1,
      provider2,
    ]);

    expect(conflicts).toEqual([]);
  });

  test("records conflict when forge shadows bundled", async () => {
    const provider1: ComponentProvider = {
      name: "bundled",
      priority: COMPONENT_PRIORITY.BUNDLED,
      attach: async () => new Map([["tool:calc", testTool("v1")]]),
    };
    const provider2: ComponentProvider = {
      name: "forge",
      priority: COMPONENT_PRIORITY.AGENT_FORGED,
      attach: async () => new Map([["tool:calc", testTool("v2")]]),
    };

    const { conflicts } = await AgentEntity.assemble(testPid(), testManifest(), [
      provider1,
      provider2,
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.key).toBe("tool:calc");
    expect(conflicts[0]?.winner).toBe("forge");
    expect(conflicts[0]?.shadowed).toEqual(["bundled"]);
  });

  test("records multiple conflicts for multiple shadowed keys", async () => {
    const provider1: ComponentProvider = {
      name: "bundled",
      priority: COMPONENT_PRIORITY.BUNDLED,
      attach: async () =>
        new Map([
          ["tool:calc", testTool("calc-b")],
          ["tool:search", testTool("search-b")],
        ]),
    };
    const provider2: ComponentProvider = {
      name: "forge",
      priority: COMPONENT_PRIORITY.AGENT_FORGED,
      attach: async () =>
        new Map([
          ["tool:calc", testTool("calc-f")],
          ["tool:search", testTool("search-f")],
        ]),
    };

    const { conflicts } = await AgentEntity.assemble(testPid(), testManifest(), [
      provider1,
      provider2,
    ]);

    expect(conflicts).toHaveLength(2);
    const keys = conflicts.map((c) => c.key).sort();
    expect(keys).toEqual(["tool:calc", "tool:search"]);
    for (const conflict of conflicts) {
      expect(conflict.winner).toBe("forge");
      expect(conflict.shadowed).toEqual(["bundled"]);
    }
  });

  test("empty providers results in empty components", async () => {
    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), []);
    expect(agent.components().size).toBe(0);
  });

  test("component retrieves typed value", async () => {
    const calc = testTool("calc");
    const provider: ComponentProvider = {
      name: "tools",
      attach: async () => new Map([["tool:calc", calc]]),
    };

    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [provider]);
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

    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [provider]);

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

    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [provider]);
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
    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [provider]);
    expect(agent.hasAll(toolToken("calc"), MEMORY)).toBe(true);
  });

  test("returns false when one token missing", async () => {
    const provider: ComponentProvider = {
      name: "provider",
      attach: async () => new Map([["tool:calc", testTool("calc")]]),
    };
    const { agent } = await AgentEntity.assemble(testPid(), testManifest(), [provider]);
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

  test("validator blocks transition — state unchanged", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    agent.setTransitionValidator(() => false);
    agent.transition({ kind: "start" });
    expect(agent.state).toBe("created"); // Blocked
  });

  test("validator allows transition — state changes normally", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    agent.setTransitionValidator(() => true);
    agent.transition({ kind: "start" });
    expect(agent.state).toBe("running");
  });

  test("no state change (no-op event) — validator not called", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    let called = false;
    agent.setTransitionValidator(() => {
      called = true;
      return false;
    });
    // "resume" from "created" is a no-op (state doesn't change)
    agent.transition({ kind: "resume" });
    expect(called).toBe(false);
    expect(agent.state).toBe("created");
  });

  test("no validator set — transitions work as before", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    // No setTransitionValidator called
    agent.transition({ kind: "start" });
    expect(agent.state).toBe("running");
    agent.transition({ kind: "complete", stopReason: "completed" });
    expect(agent.state).toBe("terminated");
  });
});

// ---------------------------------------------------------------------------
// terminationOutcome getter
// ---------------------------------------------------------------------------

describe("terminationOutcome", () => {
  test("returns undefined when not terminated", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    expect(agent.terminationOutcome).toBeUndefined();

    agent.transition({ kind: "start" });
    expect(agent.terminationOutcome).toBeUndefined();
  });

  test("returns 'success' for completed stop reason", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    agent.transition({ kind: "start" });
    agent.transition({ kind: "complete", stopReason: "completed" });
    expect(agent.terminationOutcome).toBe("success");
  });

  test("returns 'success' for max_turns stop reason", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    agent.transition({ kind: "start" });
    agent.transition({ kind: "complete", stopReason: "max_turns" });
    expect(agent.terminationOutcome).toBe("success");
  });

  test("returns 'error' for error stop reason", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    agent.transition({ kind: "start" });
    agent.transition({ kind: "error", error: new Error("boom") });
    expect(agent.terminationOutcome).toBe("error");
  });

  test("returns 'interrupted' for interrupted stop reason", () => {
    const agent = new AgentEntity(testPid(), testManifest());
    agent.transition({ kind: "start" });
    agent.transition({ kind: "complete", stopReason: "interrupted" });
    expect(agent.terminationOutcome).toBe("interrupted");
  });
});
