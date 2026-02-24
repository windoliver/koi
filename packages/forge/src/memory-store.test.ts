import { describe, expect, mock, test } from "bun:test";
import type { ToolArtifact } from "@koi/core";
import { runForgeStoreContractTests } from "@koi/test-utils";
import { createInMemoryForgeStore } from "./memory-store.js";

// Run the full contract test suite against InMemoryForgeStore
runForgeStoreContractTests(createInMemoryForgeStore);

// ---------------------------------------------------------------------------
// onChange notification tests
// ---------------------------------------------------------------------------

function testToolArtifact(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: crypto.randomUUID(),
    kind: "tool",
    name: "test-tool",
    description: "A test tool",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "test-agent",
    createdAt: Date.now(),
    version: "1.0.0",
    tags: [],
    usageCount: 0,
    contentHash: "abc123",
    implementation: "return input;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

describe("InMemoryForgeStore onChange", () => {
  test("onChange fires after successful save", async () => {
    const store = createInMemoryForgeStore();
    const listener = mock(() => {});

    store.onChange?.(listener);

    await store.save(testToolArtifact());

    // Wait for debounce (50ms)
    await new Promise((r) => setTimeout(r, 80));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("onChange fires after successful remove", async () => {
    const store = createInMemoryForgeStore();
    const listener = mock(() => {});
    const brick = testToolArtifact();

    await store.save(brick);

    // Wait for save notification to fire first
    await new Promise((r) => setTimeout(r, 80));

    store.onChange?.(listener);

    await store.remove(brick.id);

    await new Promise((r) => setTimeout(r, 80));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("onChange fires after successful update", async () => {
    const store = createInMemoryForgeStore();
    const listener = mock(() => {});
    const brick = testToolArtifact();

    await store.save(brick);

    await new Promise((r) => setTimeout(r, 80));

    store.onChange?.(listener);

    await store.update(brick.id, { lifecycle: "deprecated" });

    await new Promise((r) => setTimeout(r, 80));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("onChange does NOT fire after failed remove (non-existent)", async () => {
    const store = createInMemoryForgeStore();
    const listener = mock(() => {});

    store.onChange?.(listener);

    const result = await store.remove("non-existent-id");
    expect(result.ok).toBe(false);

    await new Promise((r) => setTimeout(r, 80));

    expect(listener).not.toHaveBeenCalled();
  });

  test("50ms debounce: two rapid saves produce one notification", async () => {
    const store = createInMemoryForgeStore();
    const listener = mock(() => {});

    store.onChange?.(listener);

    await store.save(testToolArtifact({ id: "tool-1", name: "tool-1" }));
    await store.save(testToolArtifact({ id: "tool-2", name: "tool-2" }));

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 80));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("unsubscribe prevents further notifications", async () => {
    const store = createInMemoryForgeStore();
    const listener = mock(() => {});

    const unsubscribe = store.onChange?.(listener);

    await store.save(testToolArtifact({ id: "tool-1" }));
    await new Promise((r) => setTimeout(r, 80));
    expect(listener).toHaveBeenCalledTimes(1);

    // Unsubscribe
    unsubscribe?.();

    await store.save(testToolArtifact({ id: "tool-2" }));
    await new Promise((r) => setTimeout(r, 80));

    // Still just 1 call (no new notifications)
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("multiple listeners all receive notifications", async () => {
    const store = createInMemoryForgeStore();
    const listener1 = mock(() => {});
    const listener2 = mock(() => {});

    store.onChange?.(listener1);
    store.onChange?.(listener2);

    await store.save(testToolArtifact());
    await new Promise((r) => setTimeout(r, 80));

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
  });
});
