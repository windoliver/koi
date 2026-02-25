import { describe, expect, test } from "bun:test";
import type { SandboxExecutor, TieredSandboxExecutor } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import type { BrickArtifact, SkillArtifact, ToolArtifact } from "../types.js";
import { createSearchForgeTool } from "./search-forge.js";
import type { ForgeDeps } from "./shared.js";

function createToolBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: `brick_${Math.random().toString(36).slice(2, 10)}`,
    kind: "tool",
    name: "test-brick",
    description: "A test brick",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    contentHash: "test-hash",
    implementation: "return 1;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

function createSkillBrick(overrides?: Partial<SkillArtifact>): SkillArtifact {
  return {
    id: `brick_${Math.random().toString(36).slice(2, 10)}`,
    kind: "skill",
    name: "test-skill",
    description: "A test skill",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    contentHash: "test-hash",
    content: "# Test Skill",
    ...overrides,
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

function createDeps(overrides?: Partial<ForgeDeps>): ForgeDeps {
  return {
    store: createInMemoryForgeStore(),
    executor: mockTiered({
      execute: async () => ({ ok: true, value: { output: "ok", durationMs: 1 } }),
    }),
    verifiers: [],
    config: createDefaultForgeConfig(),
    context: { agentId: "agent-1", depth: 0, sessionId: "session-1", forgesThisSession: 0 },
    ...overrides,
  };
}

describe("createSearchForgeTool", () => {
  test("has correct descriptor", () => {
    const tool = createSearchForgeTool(createDeps());
    expect(tool.descriptor.name).toBe("search_forge");
  });

  test("returns all bricks with empty query", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "b1" }));
    await store.save(createToolBrick({ id: "b2" }));

    const tool = createSearchForgeTool(createDeps({ store }));
    const result = (await tool.execute({})) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };
    expect(result.ok).toBe(true);
    expect(result.value).toHaveLength(2);
  });

  test("filters by kind", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "b1" }));
    await store.save(createSkillBrick({ id: "b2" }));

    const tool = createSearchForgeTool(createDeps({ store }));
    const result = (await tool.execute({ kind: "skill" })) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };
    expect(result.ok).toBe(true);
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.kind).toBe("skill");
  });

  test("filters by scope", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "b1", scope: "agent" }));
    await store.save(createToolBrick({ id: "b2", scope: "global" }));

    const tool = createSearchForgeTool(createDeps({ store }));
    const result = (await tool.execute({ scope: "global" })) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };
    expect(result.ok).toBe(true);
    expect(result.value).toHaveLength(1);
  });

  test("returns empty array when no matches", async () => {
    const store = createInMemoryForgeStore();
    const tool = createSearchForgeTool(createDeps({ store }));
    const result = (await tool.execute({ kind: "agent" })) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };
    expect(result.ok).toBe(true);
    expect(result.value).toHaveLength(0);
  });

  test("filters by text (case-insensitive substring on name)", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "b1", name: "calculator", description: "basic math" }));
    await store.save(
      createToolBrick({ id: "b2", name: "formatter", description: "text formatting" }),
    );

    const tool = createSearchForgeTool(createDeps({ store }));
    const result = (await tool.execute({ text: "CALC" })) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };
    expect(result.ok).toBe(true);
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.name).toBe("calculator");
  });

  test("filters by text matching description", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({ id: "b1", name: "tool-a", description: "handles JSON parsing" }),
    );
    await store.save(
      createToolBrick({ id: "b2", name: "tool-b", description: "handles CSV export" }),
    );

    const tool = createSearchForgeTool(createDeps({ store }));
    const result = (await tool.execute({ text: "json" })) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };
    expect(result.ok).toBe(true);
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.name).toBe("tool-a");
  });

  test("text search combined with kind filter", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "b1", name: "math-tool", description: "math" }));
    await store.save(createSkillBrick({ id: "b2", name: "math-skill", description: "math" }));

    const tool = createSearchForgeTool(createDeps({ store }));
    const result = (await tool.execute({ text: "math", kind: "skill" })) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };
    expect(result.ok).toBe(true);
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.kind).toBe("skill");
  });

  test("returns store error on search failure", async () => {
    const failingStore = {
      save: async () => ({ ok: true as const, value: undefined }),
      load: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "store down", retryable: false },
      }),
      search: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "store down", retryable: false },
      }),
      remove: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "store down", retryable: false },
      }),
      update: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "store down", retryable: false },
      }),
      exists: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "store down", retryable: false },
      }),
    };
    const tool = createSearchForgeTool(createDeps({ store: failingStore }));
    const result = (await tool.execute({})) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("store");
    expect(result.error.code).toBe("SEARCH_FAILED");
  });

  test("agent-scoped brick only visible to creator", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({
        id: "b1",
        scope: "agent",
        provenance: {
          ...DEFAULT_PROVENANCE,
          metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "agent-1" },
        },
      }),
    );

    const tool = createSearchForgeTool(createDeps({ store }));
    const result = (await tool.execute({})) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };
    expect(result.ok).toBe(true);
    expect(result.value).toHaveLength(1);
  });

  test("agent-scoped brick hidden from different agent", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({
        id: "b1",
        scope: "agent",
        provenance: {
          ...DEFAULT_PROVENANCE,
          metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "agent-2" },
        },
      }),
    );

    const tool = createSearchForgeTool(
      createDeps({
        store,
        context: { agentId: "agent-1", depth: 0, sessionId: "session-1", forgesThisSession: 0 },
      }),
    );
    const result = (await tool.execute({})) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };
    expect(result.ok).toBe(true);
    expect(result.value).toHaveLength(0);
  });

  test("global-scoped brick visible regardless of agentId", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({
        id: "b1",
        scope: "global",
        provenance: {
          ...DEFAULT_PROVENANCE,
          metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "agent-2" },
        },
      }),
    );

    const tool = createSearchForgeTool(
      createDeps({
        store,
        context: { agentId: "agent-1", depth: 0, sessionId: "session-1", forgesThisSession: 0 },
      }),
    );
    const result = (await tool.execute({})) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };
    expect(result.ok).toBe(true);
    expect(result.value).toHaveLength(1);
  });

  test("mixed scope query returns correct subset", async () => {
    const store = createInMemoryForgeStore();
    await store.save(
      createToolBrick({
        id: "b1",
        scope: "global",
        provenance: {
          ...DEFAULT_PROVENANCE,
          metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "other" },
        },
      }),
    );
    await store.save(
      createToolBrick({
        id: "b2",
        scope: "agent",
        provenance: {
          ...DEFAULT_PROVENANCE,
          metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "agent-1" },
        },
      }),
    );
    await store.save(
      createToolBrick({
        id: "b3",
        scope: "agent",
        provenance: {
          ...DEFAULT_PROVENANCE,
          metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "other" },
        },
      }),
    );

    const tool = createSearchForgeTool(createDeps({ store }));
    const result = (await tool.execute({})) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };
    expect(result.ok).toBe(true);
    expect(result.value).toHaveLength(2);
    const ids = result.value.map((b) => b.id);
    expect(ids).toContain("b1");
    expect(ids).toContain("b2");
  });
});
