import { describe, expect, test } from "bun:test";
import type { Agent, SubsystemToken } from "@koi/core";
import { toolToken } from "@koi/core";
import { brickToTool, createForgeComponentProviderAsync } from "./forge-component-provider.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import type { BrickArtifact, SandboxExecutor } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAgent(): Agent {
  const components = new Map<string, unknown>();
  return {
    pid: { id: "agent-1", name: "test", type: "worker", depth: 0 },
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

function createToolBrick(overrides?: Partial<BrickArtifact>): BrickArtifact {
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
    implementation: "return input.a + input.b;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

/** Create a brick with no implementation (for testing missing impl). */
function createBrickWithoutImpl(
  overrides?: Partial<Omit<BrickArtifact, "implementation">>,
): BrickArtifact {
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

  test("returns error when brick has no implementation", async () => {
    const brick = createBrickWithoutImpl();
    const tool = brickToTool(brick, echoExecutor(), 5000);

    const result = (await tool.execute({})) as {
      readonly ok: false;
      readonly error: { readonly code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("NO_IMPLEMENTATION");
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

  test("uses default schema when brick has none", async () => {
    const brick = createBrickWithoutImpl();
    const tool = brickToTool(brick, echoExecutor(), 5000);
    expect(tool.descriptor.inputSchema).toEqual({ type: "object" });
  });
});

// ---------------------------------------------------------------------------
// createForgeComponentProviderAsync
// ---------------------------------------------------------------------------

describe("createForgeComponentProviderAsync", () => {
  test("attaches tool bricks as components", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ name: "add" }));
    await store.save(createToolBrick({ name: "subtract" }));

    const provider = await createForgeComponentProviderAsync({
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
    const provider = await createForgeComponentProviderAsync({
      store,
      executor: echoExecutor(),
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(0);
  });

  test("skips non-tool bricks", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ name: "myTool" }));
    // Save a skill brick (no implementation, has content)
    const skillBrick: BrickArtifact = {
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
      content: "# Skill",
    };
    await store.save(skillBrick);

    const provider = await createForgeComponentProviderAsync({
      store,
      executor: echoExecutor(),
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(1);
  });

  test("skips tool bricks without implementation", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ name: "withImpl" }));
    await store.save(createBrickWithoutImpl({ name: "noImpl" }));

    const provider = await createForgeComponentProviderAsync({
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

    const provider = await createForgeComponentProviderAsync({
      store,
      executor: echoExecutor(),
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(1);
  });

  test("uses custom timeout", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ name: "myTool" }));

    const provider = await createForgeComponentProviderAsync({
      store,
      executor: echoExecutor(),
      sandboxTimeoutMs: 10_000,
    });

    const components = await provider.attach(createMockAgent());
    expect(components.size).toBe(1);
  });

  test("throws when store search fails", async () => {
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
    };

    await expect(
      createForgeComponentProviderAsync({ store: failingStore, executor: echoExecutor() }),
    ).rejects.toThrow("store unavailable");
  });

  test("attached tool is executable", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ name: "echo" }));

    const provider = await createForgeComponentProviderAsync({
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
