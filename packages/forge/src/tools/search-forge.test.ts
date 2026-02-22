import { describe, expect, test } from "bun:test";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import type { BrickArtifact } from "../types.js";
import { createSearchForgeTool } from "./search-forge.js";
import type { ForgeDeps } from "./shared.js";

function createBrick(overrides?: Partial<BrickArtifact>): BrickArtifact {
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
    implementation: "return 1;",
    ...overrides,
  };
}

function createDeps(overrides?: Partial<ForgeDeps>): ForgeDeps {
  return {
    store: createInMemoryForgeStore(),
    executor: { execute: async () => ({ ok: true, value: { output: "ok", durationMs: 1 } }) },
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
    await store.save(createBrick({ id: "b1" }));
    await store.save(createBrick({ id: "b2" }));

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
    await store.save(createBrick({ id: "b1", kind: "tool" }));
    await store.save(createBrick({ id: "b2", kind: "skill" }));

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
    await store.save(createBrick({ id: "b1", scope: "agent" }));
    await store.save(createBrick({ id: "b2", scope: "global" }));

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
});
