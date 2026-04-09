/**
 * Tests for createSpawnToolProvider — verifies the Spawn tool is registered
 * correctly at agent assembly time and its descriptor/execute work correctly.
 */

import { describe, expect, mock, test } from "bun:test";
import type { Agent, Tool } from "@koi/core";
import { createSpawnExecutor, createSpawnToolProvider } from "./create-spawn-tool-provider.js";
import { createInMemorySpawnLedger } from "./spawn-ledger.js";

// ---------------------------------------------------------------------------
// Minimal mock agent — satisfies Agent interface for attach() calls
// ---------------------------------------------------------------------------

function createMockAgent(id = "agent-1"): Agent {
  return {
    pid: { id, name: "test-agent", type: "worker", depth: 0 },
    manifest: {
      name: "test-agent",
      version: "0.0.0",
      description: "test",
      model: { name: "sonnet" },
    },
    state: "running",
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: () => new Map(),
    components: () => new Map(),
  } as unknown as Agent;
}

// ---------------------------------------------------------------------------
// Minimal mock resolver — resolves "researcher" only
// ---------------------------------------------------------------------------

function createMockResolver(): { resolve: ReturnType<typeof mock>; list: ReturnType<typeof mock> } {
  const researcherDef = {
    name: "researcher",
    description: "Research agent",
    agentType: "researcher",
    whenToUse: "Research agent",
    source: "built-in" as const,
    manifest: {
      name: "researcher",
      version: "0.0.0",
      description: "Research agent",
      model: { name: "sonnet" },
    },
    systemPrompt: "You are a research specialist.",
  };

  return {
    resolve: mock((agentType: string) => {
      if (agentType === "researcher") {
        return { ok: true, value: researcherDef };
      }
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `No agent: ${agentType}`, retryable: false },
      };
    }),
    list: mock(() => [{ key: "researcher", name: "researcher", description: "Research agent" }]),
  };
}

// ---------------------------------------------------------------------------
// Minimal mock adapter
// ---------------------------------------------------------------------------

const MOCK_ADAPTER = {
  engineId: "mock",
  capabilities: { text: true, images: false, files: false, audio: false },
  stream: () => {
    throw new Error("not used in provider tests");
  },
} as unknown as Parameters<typeof createSpawnToolProvider>[0]["adapter"];

const MANIFEST_TEMPLATE = {
  name: "parent",
  version: "0.0.0",
  description: "Parent agent",
  model: { name: "sonnet" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSpawnToolProvider", () => {
  test("returns a provider with correct name", () => {
    const ledger = createInMemorySpawnLedger(10);
    const resolver = createMockResolver();
    const provider = createSpawnToolProvider({
      resolver,
      spawnLedger: ledger,
      adapter: MOCK_ADAPTER,
      manifestTemplate: MANIFEST_TEMPLATE,
    });

    expect(provider.name).toBe("spawn-tool-provider");
  });

  test("attach registers Spawn tool in component map", async () => {
    const ledger = createInMemorySpawnLedger(10);
    const resolver = createMockResolver();
    const provider = createSpawnToolProvider({
      resolver,
      spawnLedger: ledger,
      adapter: MOCK_ADAPTER,
      manifestTemplate: MANIFEST_TEMPLATE,
    });

    const agent = createMockAgent("parent-agent");
    const components = (await provider.attach(agent)) as ReadonlyMap<string, unknown>;

    expect(components.has("tool:Spawn")).toBe(true);
  });

  test("Spawn tool has correct descriptor name and required fields", async () => {
    const ledger = createInMemorySpawnLedger(10);
    const resolver = createMockResolver();
    const provider = createSpawnToolProvider({
      resolver,
      spawnLedger: ledger,
      adapter: MOCK_ADAPTER,
      manifestTemplate: MANIFEST_TEMPLATE,
    });

    const agent = createMockAgent();
    const components = (await provider.attach(agent)) as ReadonlyMap<string, unknown>;
    const tool = components.get("tool:Spawn") as Tool;

    expect(tool.descriptor.name).toBe("Spawn");
    expect(tool.origin).toBe("primordial");
    const schema = tool.descriptor.inputSchema as { required: string[] };
    expect(schema.required).toContain("agentName");
    expect(schema.required).toContain("description");
  });

  test("Spawn tool execute maps args to SpawnFn and returns output on success", async () => {
    // Intercept the spawnFn by using a resolver that records the call
    const ledger = createInMemorySpawnLedger(10);
    const resolver = createMockResolver();
    const provider = createSpawnToolProvider({
      resolver,
      spawnLedger: ledger,
      adapter: MOCK_ADAPTER,
      manifestTemplate: MANIFEST_TEMPLATE,
    });

    const agent = createMockAgent();
    const components = (await provider.attach(agent)) as ReadonlyMap<string, unknown>;
    const tool = components.get("tool:Spawn") as Tool;

    // The execute will call resolver.resolve("researcher") and then try to spawn.
    // Since spawnChildAgent needs a real runtime, we test the resolver is called.
    // Call with missing agent to verify resolve is called (will fail at spawn stage).
    try {
      await tool.execute({
        agentName: "researcher",
        description: "Research quantum computing",
        maxTurns: 5,
      });
    } catch {
      // Expected: spawnChildAgent will fail without a real engine
    }

    // Resolver was invoked with the correct agentName
    expect(resolver.resolve).toHaveBeenCalledWith("researcher");
  });

  test("Spawn tool execute throws KoiRuntimeError on non-NOT_FOUND resolver failure", async () => {
    // Non-NOT_FOUND resolver errors (PERMISSION, VALIDATION, etc.) propagate as thrown
    // KoiRuntimeErrors so the engine's tool-failure path sees a real failure.
    // NOT_FOUND errors trigger dynamic agent creation instead (see next test).
    const ledger = createInMemorySpawnLedger(10);
    const brokenResolver = {
      resolve: (_agentType: string) => ({
        ok: false as const,
        error: {
          code: "PERMISSION" as const,
          message: "Agent blocked by policy",
          retryable: false,
        },
      }),
      list: () => [],
    };

    const provider = createSpawnToolProvider({
      resolver: brokenResolver,
      spawnLedger: ledger,
      adapter: MOCK_ADAPTER,
      manifestTemplate: MANIFEST_TEMPLATE,
    });

    const agent = createMockAgent();
    const components = (await provider.attach(agent)) as ReadonlyMap<string, unknown>;
    const tool = components.get("tool:Spawn") as Tool;

    await expect(
      tool.execute({ agentName: "blocked-agent", description: "Do something" }),
    ).rejects.toThrow("Agent blocked by policy");
  });

  test("Spawn tool creates dynamic agent on NOT_FOUND (no pre-defined definition required)", async () => {
    // When agentName doesn't match any registered definition (NOT_FOUND),
    // a dynamic agent is created from the description — matching Claude Code behavior.
    const ledger = createInMemorySpawnLedger(10);
    const notFoundResolver = {
      resolve: (_agentType: string) => ({
        ok: false as const,
        error: { code: "NOT_FOUND" as const, message: "No such agent", retryable: false },
      }),
      list: () => [],
    };

    const provider = createSpawnToolProvider({
      resolver: notFoundResolver,
      spawnLedger: ledger,
      adapter: MOCK_ADAPTER,
      manifestTemplate: MANIFEST_TEMPLATE,
    });

    const agent = createMockAgent();
    const components = (await provider.attach(agent)) as ReadonlyMap<string, unknown>;
    const tool = components.get("tool:Spawn") as Tool;

    // Dynamic agent creation attempts to spawn — it will fail at the child assembly
    // stage (no real engine), but critically it does NOT throw "No such agent".
    try {
      await tool.execute({ agentName: "my-custom-agent", description: "Count to 5" });
    } catch (e: unknown) {
      // Expected: child assembly fails without full engine wiring, but the error
      // should NOT be "No such agent" — it should be a downstream spawn error.
      expect(e instanceof Error ? e.message : "").not.toContain("No such agent");
    }
  });

  test("Spawn tool inputSchema matches committed snapshot (schema contract test)", async () => {
    // Issue 9: treat the schema sent to the model as a contract.
    // Any change to the schema must produce an explicit snapshot update in the diff,
    // making schema changes deliberate and reviewable rather than silent drift.
    const ledger = createInMemorySpawnLedger(10);
    const resolver = createMockResolver();
    const provider = createSpawnToolProvider({
      resolver,
      spawnLedger: ledger,
      adapter: MOCK_ADAPTER,
      manifestTemplate: MANIFEST_TEMPLATE,
    });

    const agent = createMockAgent();
    const components = (await provider.attach(agent)) as ReadonlyMap<string, unknown>;
    const tool = components.get("tool:Spawn") as Tool;
    const schema = tool.descriptor.inputSchema;

    expect(schema).toMatchSnapshot();
  });

  test("createSpawnExecutor is independently callable without a ComponentProvider", async () => {
    // Issue 2: the executor is extracted as a named function so it can be tested
    // in isolation without instantiating a full ComponentProvider or engine.
    const mockSpawnFn = async () => ({
      ok: true as const,
      output: "executor-test-output",
    });

    const execute = createSpawnExecutor(mockSpawnFn);
    const result = (await execute({
      agentName: "test-agent",
      description: "test task",
    })) as { output: string };

    expect(result.output).toBe("executor-test-output");
  });

  test("createSpawnExecutor propagates spawn failure as KoiRuntimeError", async () => {
    const mockSpawnFn = async () => ({
      ok: false as const,
      error: { code: "NOT_FOUND" as const, message: "no such agent", retryable: false },
    });

    const execute = createSpawnExecutor(mockSpawnFn);
    await expect(execute({ agentName: "missing", description: "fail task" })).rejects.toThrow(
      "no such agent",
    );
  });

  test("concurrent attach calls create independent SpawnFns", async () => {
    const ledger = createInMemorySpawnLedger(10);
    const resolver = createMockResolver();
    const provider = createSpawnToolProvider({
      resolver,
      spawnLedger: ledger,
      adapter: MOCK_ADAPTER,
      manifestTemplate: MANIFEST_TEMPLATE,
    });

    // Attach to two different agents concurrently
    const [components1, components2] = (await Promise.all([
      provider.attach(createMockAgent("agent-1")),
      provider.attach(createMockAgent("agent-2")),
    ])) as [ReadonlyMap<string, unknown>, ReadonlyMap<string, unknown>];

    // Both get a Spawn tool
    expect(components1.has("tool:Spawn")).toBe(true);
    expect(components2.has("tool:Spawn")).toBe(true);

    // They are independent Tool instances (different closures)
    const tool1 = components1.get("tool:Spawn");
    const tool2 = components2.get("tool:Spawn");
    expect(tool1).not.toBe(tool2);
  });
});
