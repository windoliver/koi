import { describe, expect, mock, test } from "bun:test";
import type { StoreChangeEvent, ToolArtifact } from "@koi/core";
import { DEFAULT_PROVENANCE, runForgeStoreContractTests } from "@koi/test-utils";
import { createInMemoryForgeStore } from "./memory-store.js";

// Run the full contract test suite against InMemoryForgeStore
runForgeStoreContractTests(createInMemoryForgeStore);

// ---------------------------------------------------------------------------
// watch notification tests
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
    provenance: DEFAULT_PROVENANCE,
    version: "1.0.0",
    tags: [],
    usageCount: 0,
    contentHash: "abc123",
    implementation: "return input;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

describe("InMemoryForgeStore watch", () => {
  test("watch fires after successful save with correct event", async () => {
    const store = createInMemoryForgeStore();
    const listener = mock(() => {});

    store.watch?.(listener);

    const brick = testToolArtifact();
    await store.save(brick);

    await new Promise((r) => setTimeout(r, 10));

    expect(listener).toHaveBeenCalledTimes(1);
    const calls = listener.mock.calls as unknown as StoreChangeEvent[][];
    const event = calls[0]?.[0];
    expect(event?.kind).toBe("saved");
    expect(event?.brickId).toBe(brick.id);
  });

  test("watch fires after successful remove with correct event", async () => {
    const store = createInMemoryForgeStore();
    const brick = testToolArtifact();

    await store.save(brick);

    const listener = mock(() => {});
    store.watch?.(listener);

    await store.remove(brick.id);

    await new Promise((r) => setTimeout(r, 10));

    expect(listener).toHaveBeenCalledTimes(1);
    const calls = listener.mock.calls as unknown as StoreChangeEvent[][];
    const event = calls[0]?.[0];
    expect(event?.kind).toBe("removed");
    expect(event?.brickId).toBe(brick.id);
  });

  test("watch fires after successful update with correct event", async () => {
    const store = createInMemoryForgeStore();
    const brick = testToolArtifact();

    await store.save(brick);

    const listener = mock(() => {});
    store.watch?.(listener);

    await store.update(brick.id, { lifecycle: "deprecated" });

    await new Promise((r) => setTimeout(r, 10));

    expect(listener).toHaveBeenCalledTimes(1);
    const calls = listener.mock.calls as unknown as StoreChangeEvent[][];
    const event = calls[0]?.[0];
    expect(event?.kind).toBe("updated");
    expect(event?.brickId).toBe(brick.id);
  });

  test("watch does NOT fire after failed remove (non-existent)", async () => {
    const store = createInMemoryForgeStore();
    const listener = mock(() => {});

    store.watch?.(listener);

    const result = await store.remove("non-existent-id");
    expect(result.ok).toBe(false);

    await new Promise((r) => setTimeout(r, 10));

    expect(listener).not.toHaveBeenCalled();
  });

  test("rapid saves fire one event each (no debounce)", async () => {
    const store = createInMemoryForgeStore();
    const listener = mock(() => {});

    store.watch?.(listener);

    await store.save(testToolArtifact({ id: "tool-1", name: "tool-1" }));
    await store.save(testToolArtifact({ id: "tool-2", name: "tool-2" }));

    await new Promise((r) => setTimeout(r, 10));

    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("unsubscribe prevents further notifications", async () => {
    const store = createInMemoryForgeStore();
    const listener = mock(() => {});

    const unsubscribe = store.watch?.(listener);

    await store.save(testToolArtifact({ id: "tool-1" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(listener).toHaveBeenCalledTimes(1);

    // Unsubscribe
    unsubscribe?.();

    await store.save(testToolArtifact({ id: "tool-2" }));
    await new Promise((r) => setTimeout(r, 10));

    // Still just 1 call (no new notifications)
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("multiple listeners all receive notifications", async () => {
    const store = createInMemoryForgeStore();
    const listener1 = mock(() => {});
    const listener2 = mock(() => {});

    store.watch?.(listener1);
    store.watch?.(listener2);

    await store.save(testToolArtifact());
    await new Promise((r) => setTimeout(r, 10));

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
  });
});
