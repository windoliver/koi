import { describe, expect, test } from "bun:test";
import type { Agent, SubsystemToken, TieredSandboxExecutor } from "@koi/core";
import {
  agentId,
  brickId,
  COMPONENT_PRIORITY,
  channelToken,
  engineToken,
  middlewareToken,
  providerToken,
  resolverToken,
  toolToken,
} from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { brickToTool, createForgeComponentProvider } from "./forge-component-provider.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import { createMemoryStoreChangeNotifier } from "./store-notifier.js";
import type {
  ImplementationArtifact,
  SandboxExecutor,
  SkillArtifact,
  ToolArtifact,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAgent(): Agent {
  const components = new Map<string, unknown>();
  return {
    pid: { id: agentId("agent-1"), name: "test", type: "worker", depth: 0 },
    manifest: {
      name: "test-agent",
      version: "0.0.0",
      model: { name: "test-model" },
    },
    state: "running",
    component: <T>(token: { toString: () => string }): T | undefined =>
      components.get(token.toString()) as T | undefined,
    has: (token: { toString: () => string }): boolean => components.has(token.toString()),
    hasAll: (...tokens: readonly { toString: () => string }[]): boolean =>
      tokens.every((t) => components.has(t.toString())),
    query: <T>(_prefix: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: (): ReadonlyMap<string, unknown> => components,
  };
}

function createToolBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: brickId(`brick_${crypto.randomUUID()}`),
    kind: "tool",
    name: "calc",
    description: "A calculator",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    implementation: "return input.a + input.b;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

function echoExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true as const,
      value: { output: input, durationMs: 1 },
    }),
  };
}

function failExecutor(): SandboxExecutor {
  return {
    execute: async (_code, _input, _timeout) => ({
      ok: false as const,
      error: { code: "CRASH" as const, message: "boom", durationMs: 1 },
    }),
  };
}

function mockTiered(exec: SandboxExecutor): TieredSandboxExecutor {
  return {
    forTier: (tier) => ({
      executor: exec,
      requestedTier: tier,
      resolvedTier: tier,
      fallback: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// brickToTool
// ---------------------------------------------------------------------------

describe("brickToTool", () => {
  test("converts brick to executable tool", async () => {
    const brick = createToolBrick();
    const tool = brickToTool(brick, echoExecutor(), 5000);

    expect(tool.descriptor.name).toBe("calc");
    expect(tool.descriptor.description).toBe("A calculator");
    expect(tool.trustTier).toBe("sandbox");

    const result = await tool.execute({ a: 1, b: 2 });
    expect(result).toEqual({ a: 1, b: 2 }); // echo executor returns input
  });

  test("returns error when sandbox fails", async () => {
    const brick = createToolBrick();
    const tool = brickToTool(brick, failExecutor(), 5000);

    const result = (await tool.execute({})) as {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("CRASH");
    expect(result.error.message).toContain("calc");
  });

  test("preserves trust tier from brick", async () => {
    const brick = createToolBrick({ trustTier: "verified" });
    const tool = brickToTool(brick, echoExecutor(), 5000);
    expect(tool.trustTier).toBe("verified");
  });

  test("passes through inputSchema from brick", async () => {
    const brick = createToolBrick({
      inputSchema: { type: "object", properties: { a: { type: "number" } } },
    });
    const tool = brickToTool(brick, echoExecutor(), 5000);
    expect(tool.descriptor.inputSchema).toEqual({
      type: "object",
      properties: { a: { type: "number" } },
    });
  });
});

// ---------------------------------------------------------------------------
// createForgeComponentProvider (lazy, attach triggers store load)
// ---------------------------------------------------------------------------

describe("createForgeComponentProvider — backward-compat attach tests", () => {
  test("attaches tool bricks as components", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ name: "add" }));
    await store.save(createToolBrick({ name: "subtract" }));

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    expect(provider.name).toBe("forge");

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(2);

    const addToken = toolToken("add") as string;
    const subToken = toolToken("subtract") as string;
    expect(components.has(addToken)).toBe(true);
    expect(components.has(subToken)).toBe(true);
  });

  test("returns empty map when store is empty", async () => {
    const store = createInMemoryForgeStore();
    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(0);
  });

  test("skips non-tool bricks", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ name: "myTool" }));
    const skillBrick: SkillArtifact = {
      id: brickId(`brick_${crypto.randomUUID()}`),
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      scope: "agent",
      trustTier: "sandbox",
      lifecycle: "active",
      provenance: DEFAULT_PROVENANCE,
      version: "0.0.1",
      tags: [],
      usageCount: 0,
      content: "# Skill",
    };
    await store.save(skillBrick);

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(1);
  });

  test("only loads active bricks", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("b1"), name: "active" }));
    await store.save(
      createToolBrick({ id: brickId("b2"), name: "deprecated", lifecycle: "deprecated" }),
    );

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(1);
  });

  test("uses custom timeout", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ name: "myTool" }));

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
      sandboxTimeoutMs: 10_000,
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(1);
  });

  test("throws when store search fails on attach", async () => {
    const failingStore = {
      save: async () => ({ ok: true as const, value: undefined }),
      load: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
      search: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "store unavailable", retryable: false },
      }),
      remove: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
      update: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
      exists: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
    };

    const provider = createForgeComponentProvider({
      store: failingStore,
      executor: mockTiered(echoExecutor()),
    });

    await expect(provider.attach(createMockAgent())).rejects.toThrow("store unavailable");
  });

  test("attached tool is executable", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ name: "echo" }));

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    const components = await provider.attach(createMockAgent());
    const token = toolToken("echo") as string;
    const tool = components.get(token) as { execute: (input: unknown) => Promise<unknown> };

    const result = await tool.execute({ hello: "world" });
    expect(result).toEqual({ hello: "world" });
  });
});

// ---------------------------------------------------------------------------
// createForgeComponentProvider (lazy, synchronous factory)
// ---------------------------------------------------------------------------

describe("createForgeComponentProvider", () => {
  test("creates provider synchronously without hitting store", () => {
    let searchCalled = false;
    const spyStore = {
      ...createInMemoryForgeStore(),
      search: async (...args: readonly unknown[]) => {
        searchCalled = true;
        return createInMemoryForgeStore().search(
          ...(args as Parameters<ReturnType<typeof createInMemoryForgeStore>["search"]>),
        );
      },
    };

    const provider = createForgeComponentProvider({
      store: spyStore,
      executor: mockTiered(echoExecutor()),
    });

    // Provider is created, store not yet queried
    expect(provider.name).toBe("forge");
    expect(searchCalled).toBe(false);
  });

  test("loads tools lazily on first attach", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ name: "lazyTool" }));

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(1);
    expect(components.has(toolToken("lazyTool") as string)).toBe(true);
  });

  test("caches tools across multiple attach calls", async () => {
    let searchCount = 0;
    const realStore = createInMemoryForgeStore();
    await realStore.save(createToolBrick({ name: "cached" }));

    const countingStore = {
      ...realStore,
      search: async (...args: readonly unknown[]) => {
        searchCount++;
        return realStore.search(...(args as Parameters<typeof realStore.search>));
      },
    };

    const provider = createForgeComponentProvider({
      store: countingStore,
      executor: mockTiered(echoExecutor()),
    });

    const first = await provider.attach(createMockAgent());
    const second = await provider.attach(createMockAgent());

    // Same reference — cached
    expect(first).toBe(second);
    // Store only queried once
    expect(searchCount).toBe(1);
  });

  test("invalidate clears cache so next attach re-queries store", async () => {
    let searchCount = 0;
    const realStore = createInMemoryForgeStore();
    await realStore.save(createToolBrick({ name: "original" }));

    const countingStore = {
      ...realStore,
      search: async (...args: readonly unknown[]) => {
        searchCount++;
        return realStore.search(...(args as Parameters<typeof realStore.search>));
      },
    };

    const provider = createForgeComponentProvider({
      store: countingStore,
      executor: mockTiered(echoExecutor()),
    });

    // First attach — loads from store
    const first = await provider.attach(createMockAgent());
    expect(first.size).toBe(1);
    expect(searchCount).toBe(1);

    // Add a new tool to the store
    await realStore.save(createToolBrick({ name: "added" }));

    // Second attach without invalidate — still returns cached
    const second = await provider.attach(createMockAgent());
    expect(second).toBe(first);
    expect(searchCount).toBe(1);

    // Invalidate the cache
    provider.invalidate();

    // Third attach — re-queries store and picks up the new tool
    const third = await provider.attach(createMockAgent());
    expect(third).not.toBe(first);
    expect(third.size).toBe(2);
    expect(searchCount).toBe(2);
  });

  test("invalidate before first attach is a no-op", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ name: "tool1" }));

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    // Invalidate before any attach — should not throw
    provider.invalidate();

    // First attach still works normally
    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(1);
  });

  test("multiple invalidations between attaches only trigger one reload", async () => {
    let searchCount = 0;
    const realStore = createInMemoryForgeStore();
    await realStore.save(createToolBrick({ name: "tool1" }));

    const countingStore = {
      ...realStore,
      search: async (...args: readonly unknown[]) => {
        searchCount++;
        return realStore.search(...(args as Parameters<typeof realStore.search>));
      },
    };

    const provider = createForgeComponentProvider({
      store: countingStore,
      executor: mockTiered(echoExecutor()),
    });

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(1);

    // Multiple invalidations
    provider.invalidate();
    provider.invalidate();
    provider.invalidate();

    // Single attach — only one store query
    await provider.attach(createMockAgent());
    expect(searchCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Scope + zoneId filtering (Issue 8A)
// ---------------------------------------------------------------------------

describe("createForgeComponentProvider — scope filtering", () => {
  test("filters out agent-scoped bricks when provider scope is zone", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("b1"), name: "agentTool", scope: "agent" }));
    await store.save(createToolBrick({ id: brickId("b2"), name: "zoneTool", scope: "zone" }));
    await store.save(createToolBrick({ id: brickId("b3"), name: "globalTool", scope: "global" }));

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
      scope: "zone",
    });

    const components = await provider.attach(createMockAgent());
    // Zone scope should see zone + global, not agent
    expect(components.size).toBe(2);
    expect(components.has(toolToken("zoneTool") as string)).toBe(true);
    expect(components.has(toolToken("globalTool") as string)).toBe(true);
    expect(components.has(toolToken("agentTool") as string)).toBe(false);
  });

  test("agent scope sees all scopes", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("b1"), name: "agentTool", scope: "agent" }));
    await store.save(createToolBrick({ id: brickId("b2"), name: "zoneTool", scope: "zone" }));
    await store.save(createToolBrick({ id: brickId("b3"), name: "globalTool", scope: "global" }));

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
      scope: "agent",
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(3);
  });

  test("global scope sees only global bricks", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("b1"), name: "agentTool", scope: "agent" }));
    await store.save(createToolBrick({ id: brickId("b2"), name: "zoneTool", scope: "zone" }));
    await store.save(createToolBrick({ id: brickId("b3"), name: "globalTool", scope: "global" }));

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
      scope: "global",
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(1);
    expect(components.has(toolToken("globalTool") as string)).toBe(true);
  });

  test("no scope filter returns all bricks (backward-compatible)", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("b1"), name: "agentTool", scope: "agent" }));
    await store.save(createToolBrick({ id: brickId("b2"), name: "zoneTool", scope: "zone" }));

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(2);
  });

  test("zone-scoped brick filtered by zoneId tag", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({
        id: brickId("b1"),
        name: "myZoneTool",
        scope: "zone",
        tags: ["zone:team-alpha"],
      }),
    );
    await store.save(
      createToolBrick({
        id: brickId("b2"),
        name: "otherZoneTool",
        scope: "zone",
        tags: ["zone:team-beta"],
      }),
    );
    await store.save(createToolBrick({ id: brickId("b3"), name: "globalTool", scope: "global" }));

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
      scope: "agent",
      zoneId: "team-alpha",
    });

    const components = await provider.attach(createMockAgent());
    // Should see: myZoneTool (matching zone), globalTool. NOT otherZoneTool.
    // Agent-scoped bricks not in this store, so 2 total.
    expect(components.size).toBe(2);
    expect(components.has(toolToken("myZoneTool") as string)).toBe(true);
    expect(components.has(toolToken("otherZoneTool") as string)).toBe(false);
    expect(components.has(toolToken("globalTool") as string)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Delta-based invalidation (Issue 15A)
// ---------------------------------------------------------------------------

describe("createForgeComponentProvider — delta invalidation", () => {
  test("invalidateByScope clears cache when matching scope exists", async () => {
    let searchCount = 0;
    const realStore = createInMemoryForgeStore();
    await realStore.save(createToolBrick({ id: brickId("b1"), name: "tool1", scope: "agent" }));

    const countingStore = {
      ...realStore,
      search: async (...args: readonly unknown[]) => {
        searchCount++;
        return realStore.search(...(args as Parameters<typeof realStore.search>));
      },
    };

    const provider = createForgeComponentProvider({
      store: countingStore,
      executor: mockTiered(echoExecutor()),
    });

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(1);

    // Invalidate by matching scope
    provider.invalidateByScope("agent");

    // Next attach should re-query
    await provider.attach(createMockAgent());
    expect(searchCount).toBe(2);
  });

  test("invalidateByScope is no-op when scope not in cache", async () => {
    let searchCount = 0;
    const realStore = createInMemoryForgeStore();
    await realStore.save(createToolBrick({ id: brickId("b1"), name: "tool1", scope: "agent" }));

    const countingStore = {
      ...realStore,
      search: async (...args: readonly unknown[]) => {
        searchCount++;
        return realStore.search(...(args as Parameters<typeof realStore.search>));
      },
    };

    const provider = createForgeComponentProvider({
      store: countingStore,
      executor: mockTiered(echoExecutor()),
    });

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(1);

    // Invalidate by non-matching scope
    provider.invalidateByScope("global");

    // Next attach should use cache (no re-query)
    await provider.attach(createMockAgent());
    expect(searchCount).toBe(1);
  });

  test("invalidateByBrickId clears cache when brick is cached", async () => {
    let searchCount = 0;
    const realStore = createInMemoryForgeStore();
    await realStore.save(createToolBrick({ id: brickId("b1"), name: "tool1" }));

    const countingStore = {
      ...realStore,
      search: async (...args: readonly unknown[]) => {
        searchCount++;
        return realStore.search(...(args as Parameters<typeof realStore.search>));
      },
    };

    const provider = createForgeComponentProvider({
      store: countingStore,
      executor: mockTiered(echoExecutor()),
    });

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(1);

    provider.invalidateByBrickId("b1");

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(2);
  });

  test("invalidateByBrickId is no-op for unknown brick", async () => {
    let searchCount = 0;
    const realStore = createInMemoryForgeStore();
    await realStore.save(createToolBrick({ id: brickId("b1"), name: "tool1" }));

    const countingStore = {
      ...realStore,
      search: async (...args: readonly unknown[]) => {
        searchCount++;
        return realStore.search(...(args as Parameters<typeof realStore.search>));
      },
    };

    const provider = createForgeComponentProvider({
      store: countingStore,
      executor: mockTiered(echoExecutor()),
    });

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(1);

    provider.invalidateByBrickId("unknown_id");

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// lookupBrickId
// ---------------------------------------------------------------------------

describe("createForgeComponentProvider — lookupBrickId", () => {
  test("returns undefined before first attach", () => {
    const store = createInMemoryForgeStore();
    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    expect(provider.lookupBrickId("calc")).toBeUndefined();
  });

  test("resolves tool name to brick ID after attach", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_abc"), name: "calc" }));

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    await provider.attach(createMockAgent());
    expect(provider.lookupBrickId("calc")).toBe("brick_abc");
  });

  test("returns undefined for non-forged tool names", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_abc"), name: "calc" }));

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    await provider.attach(createMockAgent());
    expect(provider.lookupBrickId("unknown_tool")).toBeUndefined();
  });

  test("returns undefined after invalidation", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: brickId("brick_abc"), name: "calc" }));

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    await provider.attach(createMockAgent());
    expect(provider.lookupBrickId("calc")).toBe("brick_abc");

    provider.invalidate();
    expect(provider.lookupBrickId("calc")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Notifier subscription + dispose
// ---------------------------------------------------------------------------

describe("createForgeComponentProvider — notifier integration", () => {
  test("auto-invalidates on 'saved' event", async () => {
    let searchCount = 0;
    const realStore = createInMemoryForgeStore();
    await realStore.save(createToolBrick({ id: brickId("b1"), name: "tool1" }));

    const countingStore = {
      ...realStore,
      search: async (...args: readonly unknown[]) => {
        searchCount++;
        return realStore.search(...(args as Parameters<typeof realStore.search>));
      },
    };

    const notifier = createMemoryStoreChangeNotifier();
    const provider = createForgeComponentProvider({
      store: countingStore,
      executor: mockTiered(echoExecutor()),
      notifier,
    });

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(1);

    // Simulate a new brick being saved elsewhere
    notifier.notify({ kind: "saved", brickId: brickId("b2"), scope: "agent" });

    // Cache should be invalidated — next attach re-queries
    await provider.attach(createMockAgent());
    expect(searchCount).toBe(2);
  });

  test("auto-invalidates on 'removed' event", async () => {
    let searchCount = 0;
    const realStore = createInMemoryForgeStore();
    await realStore.save(createToolBrick({ id: brickId("b1"), name: "tool1" }));

    const countingStore = {
      ...realStore,
      search: async (...args: readonly unknown[]) => {
        searchCount++;
        return realStore.search(...(args as Parameters<typeof realStore.search>));
      },
    };

    const notifier = createMemoryStoreChangeNotifier();
    const provider = createForgeComponentProvider({
      store: countingStore,
      executor: mockTiered(echoExecutor()),
      notifier,
    });

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(1);

    notifier.notify({ kind: "removed", brickId: brickId("b1") });

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(2);
  });

  test("targeted invalidation on 'updated' for cached brick", async () => {
    let searchCount = 0;
    const realStore = createInMemoryForgeStore();
    await realStore.save(createToolBrick({ id: brickId("b1"), name: "tool1" }));

    const countingStore = {
      ...realStore,
      search: async (...args: readonly unknown[]) => {
        searchCount++;
        return realStore.search(...(args as Parameters<typeof realStore.search>));
      },
    };

    const notifier = createMemoryStoreChangeNotifier();
    const provider = createForgeComponentProvider({
      store: countingStore,
      executor: mockTiered(echoExecutor()),
      notifier,
    });

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(1);

    // Update event for cached brick
    notifier.notify({ kind: "updated", brickId: brickId("b1") });

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(2);
  });

  test("no invalidation on 'updated' for unknown brick", async () => {
    let searchCount = 0;
    const realStore = createInMemoryForgeStore();
    await realStore.save(createToolBrick({ id: brickId("b1"), name: "tool1" }));

    const countingStore = {
      ...realStore,
      search: async (...args: readonly unknown[]) => {
        searchCount++;
        return realStore.search(...(args as Parameters<typeof realStore.search>));
      },
    };

    const notifier = createMemoryStoreChangeNotifier();
    const provider = createForgeComponentProvider({
      store: countingStore,
      executor: mockTiered(echoExecutor()),
      notifier,
    });

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(1);

    // Update event for a brick NOT in cache
    notifier.notify({ kind: "updated", brickId: brickId("b_unknown") });

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(1); // Cache NOT invalidated
  });

  test("promoted event with scope triggers scope-based invalidation", async () => {
    let searchCount = 0;
    const realStore = createInMemoryForgeStore();
    await realStore.save(createToolBrick({ id: brickId("b1"), name: "tool1", scope: "agent" }));

    const countingStore = {
      ...realStore,
      search: async (...args: readonly unknown[]) => {
        searchCount++;
        return realStore.search(...(args as Parameters<typeof realStore.search>));
      },
    };

    const notifier = createMemoryStoreChangeNotifier();
    const provider = createForgeComponentProvider({
      store: countingStore,
      executor: mockTiered(echoExecutor()),
      notifier,
    });

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(1);

    // Promoted event with matching scope
    notifier.notify({ kind: "promoted", brickId: brickId("b_other"), scope: "agent" });

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(2);
  });

  test("dispose unsubscribes from notifier", async () => {
    let searchCount = 0;
    const realStore = createInMemoryForgeStore();
    await realStore.save(createToolBrick({ id: brickId("b1"), name: "tool1" }));

    const countingStore = {
      ...realStore,
      search: async (...args: readonly unknown[]) => {
        searchCount++;
        return realStore.search(...(args as Parameters<typeof realStore.search>));
      },
    };

    const notifier = createMemoryStoreChangeNotifier();
    const provider = createForgeComponentProvider({
      store: countingStore,
      executor: mockTiered(echoExecutor()),
      notifier,
    });

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(1);

    // Dispose — unsubscribe from notifier
    provider.dispose();

    // Events after dispose should NOT invalidate
    notifier.notify({ kind: "saved", brickId: brickId("b2"), scope: "agent" });

    await provider.attach(createMockAgent());
    expect(searchCount).toBe(1); // Still cached
  });

  test("double dispose is safe", () => {
    const notifier = createMemoryStoreChangeNotifier();
    const provider = createForgeComponentProvider({
      store: createInMemoryForgeStore(),
      executor: mockTiered(echoExecutor()),
      notifier,
    });

    provider.dispose();
    provider.dispose(); // Should not throw
  });

  test("dispose without notifier is a no-op", () => {
    const provider = createForgeComponentProvider({
      store: createInMemoryForgeStore(),
      executor: mockTiered(echoExecutor()),
    });

    provider.dispose(); // Should not throw
  });
});

// ---------------------------------------------------------------------------
// Implementation kinds (engine, resolver, provider, middleware, channel)
// ---------------------------------------------------------------------------

function createImplementationBrick(
  kind: ImplementationArtifact["kind"],
  overrides?: Partial<ImplementationArtifact>,
): ImplementationArtifact {
  return {
    id: brickId(`brick_${crypto.randomUUID()}`),
    kind,
    name: `my-${kind}`,
    description: `A ${kind} implementation`,
    scope: "agent",
    trustTier: "verified",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    implementation: `// ${kind} code`,
    ...overrides,
  } as ImplementationArtifact;
}

describe("createForgeComponentProvider — implementation kinds", () => {
  test("attaches engine brick as ImplementationArtifact", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createImplementationBrick("engine", { name: "myEngine" }));

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    const components = await provider.attach(createMockAgent());
    expect(components.has(engineToken("myEngine") as string)).toBe(true);

    const artifact = components.get(engineToken("myEngine") as string) as ImplementationArtifact;
    expect(artifact.kind).toBe("engine");
    expect(artifact.name).toBe("myEngine");
  });

  test("attaches all 5 implementation kinds", async () => {
    const store = createInMemoryForgeStore();
    // engine/resolver/provider require "verified"; middleware/channel require "promoted"
    const verifiedKinds: readonly ImplementationArtifact["kind"][] = [
      "engine",
      "resolver",
      "provider",
    ];
    const promotedKinds: readonly ImplementationArtifact["kind"][] = ["middleware", "channel"];
    for (const kind of verifiedKinds) {
      await store.save(createImplementationBrick(kind));
    }
    for (const kind of promotedKinds) {
      await store.save(createImplementationBrick(kind, { trustTier: "promoted" }));
    }

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(5);
    expect(components.has(engineToken("my-engine") as string)).toBe(true);
    expect(components.has(resolverToken("my-resolver") as string)).toBe(true);
    expect(components.has(providerToken("my-provider") as string)).toBe(true);
    expect(components.has(middlewareToken("my-middleware") as string)).toBe(true);
    expect(components.has(channelToken("my-channel") as string)).toBe(true);
  });

  test("tools and implementations coexist", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ name: "calc" }));
    await store.save(createImplementationBrick("engine", { name: "myEngine" }));

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(2);
    expect(components.has(toolToken("calc") as string)).toBe(true);
    expect(components.has(engineToken("myEngine") as string)).toBe(true);
  });

  test("skips skill/agent/composite bricks", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ name: "myTool" }));
    await store.save(createImplementationBrick("engine", { name: "myEngine" }));
    const skillBrick: SkillArtifact = {
      id: brickId(`brick_${crypto.randomUUID()}`),
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      scope: "agent",
      trustTier: "sandbox",
      lifecycle: "active",
      provenance: DEFAULT_PROVENANCE,
      version: "0.0.1",
      tags: [],
      usageCount: 0,
      content: "# Skill",
    };
    await store.save(skillBrick);

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    const components = await provider.attach(createMockAgent());
    // tool + engine = 2, skill is skipped
    expect(components.size).toBe(2);
    expect(components.has(toolToken("myTool") as string)).toBe(true);
    expect(components.has(engineToken("myEngine") as string)).toBe(true);
  });

  test("scope filtering works for implementations", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createImplementationBrick("engine", { name: "agentEngine", scope: "agent" }));
    await store.save(
      createImplementationBrick("engine", { name: "globalEngine", scope: "global" }),
    );

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
      scope: "global",
    });

    const components = await provider.attach(createMockAgent());
    // Global scope sees only global bricks
    expect(components.size).toBe(1);
    expect(components.has(engineToken("globalEngine") as string)).toBe(true);
    expect(components.has(engineToken("agentEngine") as string)).toBe(false);
  });

  test("lookupBrickId works for implementation names", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createImplementationBrick("middleware", {
        id: brickId("brick_mw1"),
        name: "audit",
        trustTier: "promoted",
      }),
    );

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    await provider.attach(createMockAgent());
    expect(provider.lookupBrickId("audit")).toBe("brick_mw1");
  });

  test("inactive implementations are skipped", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createImplementationBrick("engine", { name: "activeEngine", lifecycle: "active" }),
    );
    await store.save(
      createImplementationBrick("engine", {
        name: "deprecatedEngine",
        lifecycle: "deprecated",
      }),
    );

    const provider = createForgeComponentProvider({
      store,
      executor: mockTiered(echoExecutor()),
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(1);
    expect(components.has(engineToken("activeEngine") as string)).toBe(true);
  });

  test("cache invalidation works for implementation bricks", async () => {
    let searchCount = 0;
    const realStore = createInMemoryForgeStore();
    await realStore.save(createImplementationBrick("engine", { name: "myEngine" }));

    const countingStore = {
      ...realStore,
      search: async (...args: readonly unknown[]) => {
        searchCount++;
        return realStore.search(...(args as Parameters<typeof realStore.search>));
      },
    };

    const notifier = createMemoryStoreChangeNotifier();
    const provider = createForgeComponentProvider({
      store: countingStore,
      executor: mockTiered(echoExecutor()),
      notifier,
    });

    const first = await provider.attach(createMockAgent());
    expect(first.size).toBe(1);
    expect(searchCount).toBe(1);

    // Add a new engine brick to the store
    await realStore.save(createImplementationBrick("resolver", { name: "myResolver" }));

    // Simulate notifier event
    notifier.notify({ kind: "saved", brickId: brickId("b2"), scope: "agent" });

    // Cache should be invalidated — next attach re-queries
    const second = await provider.attach(createMockAgent());
    expect(second.size).toBe(2);
    expect(searchCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Priority by scope
// ---------------------------------------------------------------------------

describe("createForgeComponentProvider — priority by scope", () => {
  test("agent scope sets AGENT_FORGED priority", () => {
    const provider = createForgeComponentProvider({
      store: createInMemoryForgeStore(),
      executor: mockTiered(echoExecutor()),
      scope: "agent",
    });
    expect(provider.priority).toBe(COMPONENT_PRIORITY.AGENT_FORGED);
  });

  test("zone scope sets ZONE_FORGED priority", () => {
    const provider = createForgeComponentProvider({
      store: createInMemoryForgeStore(),
      executor: mockTiered(echoExecutor()),
      scope: "zone",
    });
    expect(provider.priority).toBe(COMPONENT_PRIORITY.ZONE_FORGED);
  });

  test("global scope sets GLOBAL_FORGED priority", () => {
    const provider = createForgeComponentProvider({
      store: createInMemoryForgeStore(),
      executor: mockTiered(echoExecutor()),
      scope: "global",
    });
    expect(provider.priority).toBe(COMPONENT_PRIORITY.GLOBAL_FORGED);
  });

  test("undefined scope defaults to AGENT_FORGED priority", () => {
    const provider = createForgeComponentProvider({
      store: createInMemoryForgeStore(),
      executor: mockTiered(echoExecutor()),
    });
    expect(provider.priority).toBe(COMPONENT_PRIORITY.AGENT_FORGED);
  });
});
