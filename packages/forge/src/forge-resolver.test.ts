import { describe, expect, test } from "bun:test";
import { createForgeResolver, extractSource } from "./forge-resolver.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import type { AgentArtifact, CompositeArtifact, SkillArtifact, ToolArtifact } from "./types.js";

function createBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: `brick_${Math.random().toString(36).slice(2, 10)}`,
    kind: "tool",
    name: "test-brick",
    description: "A test brick",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "agent-1",
    createdAt: Date.now(),
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
    createdBy: "agent-1",
    createdAt: Date.now(),
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    contentHash: "test-hash",
    content: "# How to greet\nSay hello.",
    ...overrides,
  };
}

function createAgentBrick(overrides?: Partial<AgentArtifact>): AgentArtifact {
  return {
    id: `brick_${Math.random().toString(36).slice(2, 10)}`,
    kind: "agent",
    name: "test-agent",
    description: "A test agent",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "agent-1",
    createdAt: Date.now(),
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    contentHash: "test-hash",
    manifestYaml: "name: test-agent\nversion: 0.0.1",
    ...overrides,
  };
}

function createCompositeBrick(overrides?: Partial<CompositeArtifact>): CompositeArtifact {
  return {
    id: `brick_${Math.random().toString(36).slice(2, 10)}`,
    kind: "composite",
    name: "test-composite",
    description: "A test composite",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "agent-1",
    createdAt: Date.now(),
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    contentHash: "test-hash",
    brickIds: ["brick_a", "brick_b"],
    ...overrides,
  };
}

describe("createForgeResolver", () => {
  test("discover returns all bricks", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createBrick({ id: "b1" }));
    await store.save(createBrick({ id: "b2" }));

    const resolver = createForgeResolver(store);
    const results = await resolver.discover();
    expect(results).toHaveLength(2);
  });

  test("discover returns empty when store is empty", async () => {
    const store = createInMemoryForgeStore();
    const resolver = createForgeResolver(store);
    const results = await resolver.discover();
    expect(results).toHaveLength(0);
  });

  test("load returns brick by id", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createBrick({ id: "b1", name: "my-tool" }));

    const resolver = createForgeResolver(store);
    const result = await resolver.load("b1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("my-tool");
    }
  });

  test("load returns NOT_FOUND for missing id", async () => {
    const store = createInMemoryForgeStore();
    const resolver = createForgeResolver(store);
    const result = await resolver.load("nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("discover throws when store search fails", async () => {
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
    const resolver = createForgeResolver(failingStore);
    await expect(resolver.discover()).rejects.toThrow("store down");
  });
});

// ---------------------------------------------------------------------------
// extractSource
// ---------------------------------------------------------------------------

describe("extractSource", () => {
  test("tool brick returns implementation as typescript", () => {
    const brick = createBrick({ implementation: "return 42;" });
    const bundle = extractSource(brick);
    expect(bundle.content).toBe("return 42;");
    expect(bundle.language).toBe("typescript");
    expect(bundle.files).toBeUndefined();
  });

  test("skill brick returns content as markdown", () => {
    const brick = createSkillBrick({ content: "# Greeting\nSay hi." });
    const bundle = extractSource(brick);
    expect(bundle.content).toBe("# Greeting\nSay hi.");
    expect(bundle.language).toBe("markdown");
  });

  test("agent brick returns manifestYaml as yaml", () => {
    const brick = createAgentBrick({ manifestYaml: "name: agent\nversion: 1.0" });
    const bundle = extractSource(brick);
    expect(bundle.content).toBe("name: agent\nversion: 1.0");
    expect(bundle.language).toBe("yaml");
  });

  test("composite brick returns JSON brickIds as json", () => {
    const brick = createCompositeBrick({ brickIds: ["a", "b", "c"] });
    const bundle = extractSource(brick);
    expect(bundle.language).toBe("json");
    expect(JSON.parse(bundle.content)).toEqual(["a", "b", "c"]);
  });

  test("includes companion files when present", () => {
    const files = { "helper.ts": "export const x = 1;" };
    const brick = createBrick({ files });
    const bundle = extractSource(brick);
    expect(bundle.files).toEqual(files);
  });

  test("omits files field when not present on brick", () => {
    const brick = createBrick();
    const bundle = extractSource(brick);
    expect("files" in bundle).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ForgeResolver.source()
// ---------------------------------------------------------------------------

describe("ForgeResolver.source()", () => {
  test("source returns content for tool brick", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createBrick({ id: "t1", implementation: "return 42;" }));

    const resolver = createForgeResolver(store);
    expect(resolver.source).toBeDefined();
    const result = await resolver.source?.("t1");
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("return 42;");
      expect(result.value.language).toBe("typescript");
    }
  });

  test("source returns NOT_FOUND for missing id", async () => {
    const store = createInMemoryForgeStore();
    const resolver = createForgeResolver(store);
    expect(resolver.source).toBeDefined();
    const result = await resolver.source?.("nonexistent");
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});
