/**
 * Manifest-level spawn inheritance narrowing tests (Issue #1425).
 *
 * Verifies that manifest.spawn.tools declarations act as a capability ceiling:
 * - allowlist mode: child inherits only tools declared in manifest.list
 * - denylist mode: manifest.list tools are always excluded (on top of runtime denylist)
 * - ceiling is enforced even when runtime SpawnRequest doesn't specify any tool lists
 * - runtime options can further restrict but never escalate beyond the manifest ceiling
 * - 3-level chain: attenuation holds recursively (grandchild cannot escalate beyond grandparent)
 */

import { describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentManifest,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineOutput,
  SubsystemToken,
  Tool,
} from "@koi/core";
import { agentId, DEFAULT_SANDBOXED_POLICY, toolToken } from "@koi/core";
import { DEFAULT_SPAWN_POLICY } from "@koi/engine-compose";
import { spawnChildAgent } from "../spawn-child.js";
import { createInMemorySpawnLedger } from "../spawn-ledger.js";
import type { SpawnChildOptions } from "../types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    name: "child-agent",
    version: "0.1.0",
    model: { name: "test-model" },
    ...overrides,
  };
}

function mockOutput(): EngineOutput {
  return {
    content: [{ kind: "text", text: "done" }],
    stopReason: "completed",
    metrics: { totalTokens: 10, inputTokens: 5, outputTokens: 5, turns: 1, durationMs: 100 },
  };
}

function createTestAdapter(): EngineAdapter {
  return {
    engineId: "narrowing-test",
    capabilities: { text: true, images: false, files: false, audio: false },
    stream: (_input: EngineInput) => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<EngineEvent> {
        yield { kind: "done" as const, output: mockOutput() };
      },
    }),
  };
}

function mockTool(name: string): Tool {
  return {
    descriptor: { name, description: `Mock tool ${name}`, inputSchema: { type: "object" } },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async () => ({ result: name }),
  };
}

/** Build a mock parent Agent with the given manifest and optional tools. */
function mockParent(
  manifest: AgentManifest,
  tools: ReadonlyMap<string, unknown> = new Map(),
): Agent {
  const components = tools;
  return {
    pid: { id: agentId("parent-narrowing"), name: "parent", type: "copilot", depth: 0 },
    manifest,
    state: "running",
    component: <T>(tok: SubsystemToken<T>) => components.get(tok as string) as T | undefined,
    has: (tok) => components.has(tok as string),
    hasAll: (...tokens) => tokens.every((t) => components.has(t as string)),
    query: <T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> => {
      const result = new Map<SubsystemToken<T>, T>();
      for (const [key, value] of components) {
        if (key.startsWith(prefix)) {
          result.set(key as SubsystemToken<T>, value as T);
        }
      }
      return result;
    },
    components: () => components as ReadonlyMap<string, unknown>,
  };
}

function baseOptions(overrides?: Partial<SpawnChildOptions>): SpawnChildOptions {
  return {
    manifest: testManifest(),
    adapter: createTestAdapter(),
    parentAgent: mockParent({ name: "parent", version: "0.1.0", model: { name: "test" } }),
    spawnLedger: createInMemorySpawnLedger(10),
    spawnPolicy: DEFAULT_SPAWN_POLICY,
    ...overrides,
  };
}

function toolsOf(agent: Agent): Set<string> {
  const result = new Set<string>();
  for (const [key] of agent.query<Tool>("tool:")) {
    const name = (key as string).slice("tool:".length);
    result.add(name);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Manifest allowlist mode
// ---------------------------------------------------------------------------

describe("manifest spawn ceiling — allowlist mode", () => {
  test("child only inherits tools declared in manifest allowlist", async () => {
    const toolA = mockTool("ToolA");
    const toolB = mockTool("ToolB");
    const toolC = mockTool("ToolC");
    const parentTools = new Map<string, unknown>([
      [toolToken("ToolA") as string, toolA],
      [toolToken("ToolB") as string, toolB],
      [toolToken("ToolC") as string, toolC],
    ]);

    const parentManifest: AgentManifest = {
      name: "parent",
      version: "0.1.0",
      model: { name: "test" },
      spawn: { tools: { policy: "allowlist", list: ["ToolA", "ToolB"] } },
    };
    const parent = mockParent(parentManifest, parentTools);

    const result = await spawnChildAgent(
      baseOptions({ parentAgent: parent, spawnLedger: createInMemorySpawnLedger(10) }),
    );

    const childTools = toolsOf(result.runtime.agent);
    expect(childTools.has("ToolA")).toBe(true);
    expect(childTools.has("ToolB")).toBe(true);
    expect(childTools.has("ToolC")).toBe(false); // ceiling excludes ToolC
  });

  test("runtime toolAllowlist further restricts within manifest ceiling", async () => {
    const toolA = mockTool("ToolA");
    const toolB = mockTool("ToolB");
    const toolC = mockTool("ToolC");
    const parentTools = new Map<string, unknown>([
      [toolToken("ToolA") as string, toolA],
      [toolToken("ToolB") as string, toolB],
      [toolToken("ToolC") as string, toolC],
    ]);

    // Manifest ceiling: ToolA and ToolB. Runtime further restricts to ToolA only.
    const parentManifest: AgentManifest = {
      name: "parent",
      version: "0.1.0",
      model: { name: "test" },
      spawn: { tools: { policy: "allowlist", list: ["ToolA", "ToolB"] } },
    };
    const parent = mockParent(parentManifest, parentTools);

    const result = await spawnChildAgent(
      baseOptions({
        parentAgent: parent,
        spawnLedger: createInMemorySpawnLedger(10),
        toolAllowlist: ["ToolA"], // further restrict — only ToolA within the ceiling
      }),
    );

    const childTools = toolsOf(result.runtime.agent);
    expect(childTools.has("ToolA")).toBe(true);
    expect(childTools.has("ToolB")).toBe(false); // runtime allowlist excludes ToolB
    expect(childTools.has("ToolC")).toBe(false); // ceiling excludes ToolC
  });

  test("manifest allowlist with empty list means child inherits no tools", async () => {
    const toolA = mockTool("ToolA");
    const parentTools = new Map<string, unknown>([[toolToken("ToolA") as string, toolA]]);
    const parentManifest: AgentManifest = {
      name: "parent",
      version: "0.1.0",
      model: { name: "test" },
      spawn: { tools: { policy: "allowlist", list: [] } },
    };
    const parent = mockParent(parentManifest, parentTools);

    const result = await spawnChildAgent(
      baseOptions({ parentAgent: parent, spawnLedger: createInMemorySpawnLedger(10) }),
    );

    const childTools = toolsOf(result.runtime.agent);
    expect(childTools.has("ToolA")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Manifest denylist mode
// ---------------------------------------------------------------------------

describe("manifest spawn ceiling — denylist mode", () => {
  test("manifest denylist always excludes listed tools regardless of runtime options", async () => {
    const toolA = mockTool("ToolA");
    const toolB = mockTool("ToolB");
    const toolC = mockTool("ToolC");
    const parentTools = new Map<string, unknown>([
      [toolToken("ToolA") as string, toolA],
      [toolToken("ToolB") as string, toolB],
      [toolToken("ToolC") as string, toolC],
    ]);

    const parentManifest: AgentManifest = {
      name: "parent",
      version: "0.1.0",
      model: { name: "test" },
      spawn: { tools: { policy: "denylist", list: ["ToolC"] } },
    };
    const parent = mockParent(parentManifest, parentTools);

    const result = await spawnChildAgent(
      baseOptions({ parentAgent: parent, spawnLedger: createInMemorySpawnLedger(10) }),
    );

    const childTools = toolsOf(result.runtime.agent);
    expect(childTools.has("ToolA")).toBe(true);
    expect(childTools.has("ToolB")).toBe(true);
    expect(childTools.has("ToolC")).toBe(false); // excluded by manifest denylist
  });

  test("manifest denylist combines with runtime denylist (union)", async () => {
    const toolA = mockTool("ToolA");
    const toolB = mockTool("ToolB");
    const toolC = mockTool("ToolC");
    const parentTools = new Map<string, unknown>([
      [toolToken("ToolA") as string, toolA],
      [toolToken("ToolB") as string, toolB],
      [toolToken("ToolC") as string, toolC],
    ]);

    const parentManifest: AgentManifest = {
      name: "parent",
      version: "0.1.0",
      model: { name: "test" },
      spawn: { tools: { policy: "denylist", list: ["ToolC"] } }, // manifest excludes C
    };
    const parent = mockParent(parentManifest, parentTools);

    const result = await spawnChildAgent(
      baseOptions({
        parentAgent: parent,
        spawnLedger: createInMemorySpawnLedger(10),
        toolDenylist: ["ToolB"], // runtime also excludes B
      }),
    );

    const childTools = toolsOf(result.runtime.agent);
    expect(childTools.has("ToolA")).toBe(true);
    expect(childTools.has("ToolB")).toBe(false); // runtime denylist
    expect(childTools.has("ToolC")).toBe(false); // manifest denylist
  });

  test("when no manifest spawn config, all parent tools are inherited by default", async () => {
    const toolA = mockTool("ToolA");
    const toolB = mockTool("ToolB");
    const parentTools = new Map<string, unknown>([
      [toolToken("ToolA") as string, toolA],
      [toolToken("ToolB") as string, toolB],
    ]);
    const parentManifest: AgentManifest = {
      name: "parent",
      version: "0.1.0",
      model: { name: "test" },
      // no spawn field — default behavior
    };
    const parent = mockParent(parentManifest, parentTools);

    const result = await spawnChildAgent(
      baseOptions({ parentAgent: parent, spawnLedger: createInMemorySpawnLedger(10) }),
    );

    const childTools = toolsOf(result.runtime.agent);
    expect(childTools.has("ToolA")).toBe(true);
    expect(childTools.has("ToolB")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3-level chain: grandchild attenuation (Issue #1425 — Issue 11)
// ---------------------------------------------------------------------------

describe("3-level narrowing chain — grandchild cannot escalate beyond grandparent", () => {
  test("grandchild only sees tools present in child (transitive narrowing)", async () => {
    // Grandparent has A, B, C; spawns child with C excluded → child has A, B
    // Child spawns grandchild with no additional constraints → grandchild has A, B (not C)
    const toolA = mockTool("ToolA");
    const toolB = mockTool("ToolB");
    const toolC = mockTool("ToolC");
    const grandparentTools = new Map<string, unknown>([
      [toolToken("ToolA") as string, toolA],
      [toolToken("ToolB") as string, toolB],
      [toolToken("ToolC") as string, toolC],
    ]);

    const grandparent = mockParent(
      { name: "grandparent", version: "0.1.0", model: { name: "test" } },
      grandparentTools,
    );

    // Spawn child: gets A, B (C excluded)
    const childResult = await spawnChildAgent(
      baseOptions({
        parentAgent: grandparent,
        spawnLedger: createInMemorySpawnLedger(10),
        toolDenylist: ["ToolC"],
      }),
    );

    const childTools = toolsOf(childResult.runtime.agent);
    expect(childTools.has("ToolA")).toBe(true);
    expect(childTools.has("ToolB")).toBe(true);
    expect(childTools.has("ToolC")).toBe(false); // confirmed: child doesn't have C

    // Spawn grandchild from child: inherits from child's restricted tool set
    const grandchildResult = await spawnChildAgent(
      baseOptions({
        parentAgent: childResult.runtime.agent, // child is now the parent
        spawnLedger: createInMemorySpawnLedger(10),
        // No toolDenylist — grandchild gets whatever child has
      }),
    );

    const grandchildTools = toolsOf(grandchildResult.runtime.agent);
    expect(grandchildTools.has("ToolA")).toBe(true);
    expect(grandchildTools.has("ToolB")).toBe(true);
    expect(grandchildTools.has("ToolC")).toBe(false); // C never in child → not in grandchild
  });

  test("Spawn tool is excluded from grandchild's tool set (always-excluded rule is recursive)", async () => {
    // Even if grandparent had Spawn in its tool set, it should not appear in grandchild
    const toolA = mockTool("ToolA");
    const spawnTool = mockTool("Spawn"); // simulate a Spawn tool in parent
    const grandparentTools = new Map<string, unknown>([
      [toolToken("ToolA") as string, toolA],
      [toolToken("Spawn") as string, spawnTool],
    ]);

    const grandparent = mockParent(
      { name: "grandparent", version: "0.1.0", model: { name: "test" } },
      grandparentTools,
    );

    // Child: Spawn is always excluded from inheritance
    const childResult = await spawnChildAgent(
      baseOptions({
        parentAgent: grandparent,
        spawnLedger: createInMemorySpawnLedger(10),
      }),
    );

    const childTools = toolsOf(childResult.runtime.agent);
    expect(childTools.has("ToolA")).toBe(true);
    expect(childTools.has("Spawn")).toBe(false); // always excluded

    // Grandchild: still no Spawn (child didn't have it, so grandchild can't inherit it)
    const grandchildResult = await spawnChildAgent(
      baseOptions({
        parentAgent: childResult.runtime.agent,
        spawnLedger: createInMemorySpawnLedger(10),
      }),
    );

    const grandchildTools = toolsOf(grandchildResult.runtime.agent);
    expect(grandchildTools.has("ToolA")).toBe(true);
    expect(grandchildTools.has("Spawn")).toBe(false);
  });

  test("grandchild with manifest ceiling cannot access tool excluded at child level", async () => {
    // Grandparent: manifest allowlist [A, B, C]
    // Child spawned with denylist [C] → child has [A, B]
    // Grandchild inherits from child [A, B] — manifest ceiling applies recursively
    const toolA = mockTool("ToolA");
    const toolB = mockTool("ToolB");
    const toolC = mockTool("ToolC");
    const gpTools = new Map<string, unknown>([
      [toolToken("ToolA") as string, toolA],
      [toolToken("ToolB") as string, toolB],
      [toolToken("ToolC") as string, toolC],
    ]);

    const grandparentManifest: AgentManifest = {
      name: "grandparent",
      version: "0.1.0",
      model: { name: "test" },
      spawn: { tools: { policy: "allowlist", list: ["ToolA", "ToolB", "ToolC"] } },
    };
    const grandparent = mockParent(grandparentManifest, gpTools);

    const childManifest: AgentManifest = {
      name: "child",
      version: "0.1.0",
      model: { name: "test" },
      spawn: { tools: { policy: "allowlist", list: ["ToolA", "ToolB"] } }, // child's ceiling
    };
    const childResult = await spawnChildAgent(
      baseOptions({
        manifest: childManifest,
        parentAgent: grandparent,
        spawnLedger: createInMemorySpawnLedger(10),
      }),
    );

    // Child assembled with own manifest (not grandparent's), inherits all GP tools
    // Child's manifest.spawn is for CHILDREN it spawns — not applied to itself here
    // Grandparent's manifest.spawn allowlist [A, B, C] applies → child gets A, B, C
    const childTools = toolsOf(childResult.runtime.agent);
    expect(childTools.has("ToolA")).toBe(true);
    expect(childTools.has("ToolB")).toBe(true);
    expect(childTools.has("ToolC")).toBe(true); // grandparent ceiling includes C

    // Grandchild spawned from child: child's manifest.spawn allowlist [A, B] applies
    const grandchildResult = await spawnChildAgent(
      baseOptions({
        parentAgent: childResult.runtime.agent, // child is parent, with manifest.spawn = [A, B]
        spawnLedger: createInMemorySpawnLedger(10),
      }),
    );

    const grandchildTools = toolsOf(grandchildResult.runtime.agent);
    expect(grandchildTools.has("ToolA")).toBe(true);
    expect(grandchildTools.has("ToolB")).toBe(true);
    expect(grandchildTools.has("ToolC")).toBe(false); // child's ceiling excludes C for grandchild
  });
});
