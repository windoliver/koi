import { describe, expect, test } from "bun:test";
import { createForgeResolver } from "./forge-resolver.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import type { BrickArtifact } from "./types.js";

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
});
