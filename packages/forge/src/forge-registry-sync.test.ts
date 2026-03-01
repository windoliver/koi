import { describe, expect, test } from "bun:test";
import type { BrickArtifact, BrickRegistryWriter, KoiError, Result } from "@koi/core";
import { brickId } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { createForgeRegistrySync } from "./forge-registry-sync.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import type { ToolArtifact } from "./types.js";

function createBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: brickId(`brick_${Math.random().toString(36).slice(2, 10)}`),
    kind: "tool",
    name: "test-brick",
    description: "A test brick",
    scope: "agent",
    trustTier: "promoted",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    implementation: "return 1;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

function createMockRegistry(
  registerFn?: (brick: BrickArtifact) => Result<void, KoiError> | Promise<Result<void, KoiError>>,
): BrickRegistryWriter {
  return {
    register: registerFn ?? (async () => ({ ok: true as const, value: undefined })),
    unregister: async () => ({ ok: true as const, value: undefined }),
  };
}

describe("createForgeRegistrySync", () => {
  test("publishes brick to registry on promoted event", async () => {
    const store = createInMemoryForgeStore();
    const brick = createBrick({ id: brickId("b1"), name: "promoted-tool" });
    await store.save(brick);

    const registered: string[] = [];
    const registry = createMockRegistry(async (b) => {
      registered.push(b.name);
      return { ok: true, value: undefined };
    });

    const published: Array<{ brickId: string; name: string }> = [];
    createForgeRegistrySync({
      forgeStore: store,
      registry,
      onPublished: (id, name) => {
        published.push({ brickId: id, name });
      },
    });

    // Trigger a promotion event by calling promoteAndUpdate
    await store.promoteAndUpdate?.(brickId("b1"), "global", { trustTier: "promoted" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(registered).toHaveLength(1);
    expect(registered[0]).toBe("promoted-tool");
    expect(published).toHaveLength(1);
    expect(published[0]?.name).toBe("promoted-tool");
  });

  test("ignores non-promotion events (saved, updated, removed)", async () => {
    const store = createInMemoryForgeStore();
    const brick = createBrick({ id: brickId("b1") });

    const registered: string[] = [];
    const registry = createMockRegistry(async (b) => {
      registered.push(b.name);
      return { ok: true, value: undefined };
    });

    createForgeRegistrySync({ forgeStore: store, registry });

    // save → "saved" event
    await store.save(brick);
    // update → "updated" event
    await store.update(brickId("b1"), { usageCount: 5 });
    // remove → "removed" event
    await store.remove(brickId("b1"));

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(registered).toHaveLength(0);
  });

  test("calls onError when registry.register fails", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createBrick({ id: brickId("b1") }));

    const registry = createMockRegistry(async () => {
      throw new Error("registry unavailable");
    });

    const errors: Array<{ brickId: string; error: unknown }> = [];
    createForgeRegistrySync({
      forgeStore: store,
      registry,
      onError: (id, err) => {
        errors.push({ brickId: id, error: err });
      },
    });

    await store.promoteAndUpdate?.(brickId("b1"), "global", { trustTier: "promoted" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.brickId).toBe(brickId("b1"));
    expect(errors[0]?.error).toBeInstanceOf(Error);
    if (errors[0]?.error instanceof Error) {
      expect(errors[0].error.message).toBe("registry unavailable");
    }
  });

  test("calls onPublished on success", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createBrick({ id: brickId("b1"), name: "my-tool" }));

    const registry = createMockRegistry();
    const published: Array<{ brickId: string; name: string }> = [];

    createForgeRegistrySync({
      forgeStore: store,
      registry,
      onPublished: (id, name) => {
        published.push({ brickId: id, name });
      },
    });

    await store.promoteAndUpdate?.(brickId("b1"), "global", { trustTier: "promoted" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(published).toHaveLength(1);
    expect(published[0]?.brickId).toBe(brickId("b1"));
    expect(published[0]?.name).toBe("my-tool");
  });

  test("unsubscribe stops listening", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createBrick({ id: brickId("b1") }));

    const registered: string[] = [];
    const registry = createMockRegistry(async (b) => {
      registered.push(b.name);
      return { ok: true, value: undefined };
    });

    const unsubscribe = createForgeRegistrySync({ forgeStore: store, registry });

    // Unsubscribe before triggering promotion
    unsubscribe();

    await store.promoteAndUpdate?.(brickId("b1"), "global", { trustTier: "promoted" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(registered).toHaveLength(0);
  });
});
