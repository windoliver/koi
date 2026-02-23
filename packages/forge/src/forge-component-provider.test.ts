import { describe, expect, test } from "bun:test";
import type { Agent, SubsystemToken } from "@koi/core";
import { agentId, toolToken } from "@koi/core";
import { brickToTool, createForgeComponentProvider } from "./forge-component-provider.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import type { SandboxExecutor, SkillArtifact, ToolArtifact } from "./types.js";

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
    id: `brick_${crypto.randomUUID()}`,
    kind: "tool",
    name: "calc",
    description: "A calculator",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "agent-1",
    createdAt: Date.now(),
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    contentHash: "test-hash",
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
      executor: echoExecutor(),
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
      executor: echoExecutor(),
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(0);
  });

  test("skips non-tool bricks", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ name: "myTool" }));
    const skillBrick: SkillArtifact = {
      id: `brick_${crypto.randomUUID()}`,
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      scope: "agent",
      trustTier: "sandbox",
      lifecycle: "active",
      createdBy: "agent-1",
      createdAt: Date.now(),
      version: "0.0.1",
      tags: [],
      usageCount: 0,
      contentHash: "test-hash",
      content: "# Skill",
    };
    await store.save(skillBrick);

    const provider = createForgeComponentProvider({
      store,
      executor: echoExecutor(),
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(1);
  });

  test("only loads active bricks", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "b1", name: "active" }));
    await store.save(createToolBrick({ id: "b2", name: "deprecated", lifecycle: "deprecated" }));

    const provider = createForgeComponentProvider({
      store,
      executor: echoExecutor(),
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(1);
  });

  test("uses custom timeout", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ name: "myTool" }));

    const provider = createForgeComponentProvider({
      store,
      executor: echoExecutor(),
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
      executor: echoExecutor(),
    });

    await expect(provider.attach(createMockAgent())).rejects.toThrow("store unavailable");
  });

  test("attached tool is executable", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ name: "echo" }));

    const provider = createForgeComponentProvider({
      store,
      executor: echoExecutor(),
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
      executor: echoExecutor(),
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
      executor: echoExecutor(),
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
      executor: echoExecutor(),
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
      executor: echoExecutor(),
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
      executor: echoExecutor(),
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
      executor: echoExecutor(),
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
