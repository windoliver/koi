/**
 * Unit tests for createForgeRuntime factory.
 */

import { describe, expect, mock, test } from "bun:test";
import type { ToolArtifact } from "@koi/core";
import { createForgeRuntime } from "./forge-runtime.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import type { SandboxExecutor, TieredSandboxExecutor } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
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

function mockExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
  };
}

function mockTiered(exec?: SandboxExecutor): TieredSandboxExecutor {
  const e = exec ?? mockExecutor();
  return {
    forTier: (tier) => ({
      executor: e,
      requestedTier: tier,
      resolvedTier: tier,
      fallback: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createForgeRuntime", () => {
  test("resolveTool returns Tool for active tool in store", async () => {
    const store = createInMemoryForgeStore();
    const brick = testToolArtifact({ name: "adder" });
    await store.save(brick);

    const runtime = createForgeRuntime({ store, executor: mockTiered() });
    const tool = await runtime.resolveTool("adder");

    expect(tool).toBeDefined();
    expect(tool?.descriptor.name).toBe("adder");
  });

  test("resolveTool returns undefined for non-existent tool", async () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockTiered() });

    const tool = await runtime.resolveTool("nonexistent");
    expect(tool).toBeUndefined();
  });

  test("resolveTool returns undefined for inactive (draft) tool", async () => {
    const store = createInMemoryForgeStore();
    await store.save(testToolArtifact({ name: "draft-tool", lifecycle: "draft" }));

    const runtime = createForgeRuntime({ store, executor: mockTiered() });
    const tool = await runtime.resolveTool("draft-tool");

    expect(tool).toBeUndefined();
  });

  test("toolDescriptors returns descriptors for all active tools", async () => {
    const store = createInMemoryForgeStore();
    await store.save(testToolArtifact({ id: "t1", name: "tool-a" }));
    await store.save(testToolArtifact({ id: "t2", name: "tool-b" }));
    await store.save(testToolArtifact({ id: "t3", name: "draft-tool", lifecycle: "draft" }));

    const runtime = createForgeRuntime({ store, executor: mockTiered() });
    const descriptors = await runtime.toolDescriptors();

    expect(descriptors).toHaveLength(2);
    const names = descriptors.map((d) => d.name);
    expect(names).toContain("tool-a");
    expect(names).toContain("tool-b");
  });

  test("toolDescriptors returns empty array when store is empty", async () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockTiered() });

    const descriptors = await runtime.toolDescriptors();
    expect(descriptors).toHaveLength(0);
  });

  test("cache invalidation: forge new tool → watch → resolveTool finds it", async () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockTiered() });

    // Initially no tools
    const before = await runtime.resolveTool("new-tool");
    expect(before).toBeUndefined();

    // Save a new tool to the store
    await store.save(testToolArtifact({ name: "new-tool" }));

    // Events fire immediately — flush microtasks
    await new Promise((r) => setTimeout(r, 10));

    // After watch fires, cache should be invalidated
    const after = await runtime.resolveTool("new-tool");
    expect(after).toBeDefined();
    expect(after?.descriptor.name).toBe("new-tool");
  });

  test("watch propagates typed events from store", async () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockTiered() });

    expect(runtime.watch).toBeDefined();

    const listener = mock(() => {});
    const unsub = runtime.watch?.(listener);

    await store.save(testToolArtifact());
    await new Promise((r) => setTimeout(r, 10));

    expect(listener).toHaveBeenCalledTimes(1);
    // Verify typed event payload
    const calls = listener.mock.calls as unknown as import("@koi/core").StoreChangeEvent[][];
    const event = calls[0]?.[0];
    expect(event).toBeDefined();
    expect(event?.kind).toBe("saved");

    unsub?.();
  });

  test("dispose calls store.dispose when available", () => {
    const store = createInMemoryForgeStore();
    const disposeSpy = mock(() => {});
    // Attach a dispose method to the store
    const storeWithDispose = { ...store, dispose: disposeSpy };

    const runtime = createForgeRuntime({ store: storeWithDispose, executor: mockTiered() });
    runtime.dispose?.();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  test("dispose works when store has no dispose method", () => {
    const store = createInMemoryForgeStore();
    const runtime = createForgeRuntime({ store, executor: mockTiered() });

    // Should not throw even though store has no dispose
    expect(() => runtime.dispose?.()).not.toThrow();
  });
});
