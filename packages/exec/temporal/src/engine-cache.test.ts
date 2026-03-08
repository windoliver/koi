/**
 * Tests for engine cache — reuse createKoi() across Activity turns.
 * Decision 13A: Cache engine across turns with key-based invalidation.
 */

import { describe, expect, mock, test } from "bun:test";
import { type CachedRuntime, createEngineCache, type RuntimeFactory } from "./engine-cache.js";
import type { EngineCacheKey } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRuntime(id: string): CachedRuntime {
  return {
    async *run() {
      yield { kind: "done", id };
    },
  };
}

function createMockFactory(): RuntimeFactory & { readonly calls: number } {
  let calls = 0;
  const factory = mock(async (_options: Record<string, unknown>) => {
    calls++;
    return createMockRuntime(`runtime-${calls}`);
  }) as unknown as RuntimeFactory & { readonly calls: number };
  Object.defineProperty(factory, "calls", {
    get: () => calls,
  });
  return factory;
}

const KEY_A: EngineCacheKey = { manifestHash: "hash-a", forgeGeneration: 1 };
const KEY_B: EngineCacheKey = { manifestHash: "hash-b", forgeGeneration: 1 };
const KEY_A_GEN2: EngineCacheKey = { manifestHash: "hash-a", forgeGeneration: 2 };

// ---------------------------------------------------------------------------
// Cache hit/miss
// ---------------------------------------------------------------------------

describe("createEngineCache", () => {
  test("first call creates engine via factory", async () => {
    const factory = createMockFactory();
    const cache = createEngineCache(factory);

    const runtime = await cache.getOrCreate(KEY_A, {} as never);

    expect(runtime).toBeDefined();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(cache.hasCached()).toBe(true);
  });

  test("subsequent call with same key returns cached instance", async () => {
    const factory = createMockFactory();
    const cache = createEngineCache(factory);

    const first = await cache.getOrCreate(KEY_A, {} as never);
    const second = await cache.getOrCreate(KEY_A, {} as never);

    expect(first).toBe(second); // Same reference
    expect(factory).toHaveBeenCalledTimes(1); // Only one creation
  });

  test("different manifest hash creates new instance", async () => {
    const factory = createMockFactory();
    const cache = createEngineCache(factory);

    const first = await cache.getOrCreate(KEY_A, {} as never);
    const second = await cache.getOrCreate(KEY_B, {} as never);

    expect(first).not.toBe(second);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  test("different forge generation creates new instance", async () => {
    const factory = createMockFactory();
    const cache = createEngineCache(factory);

    const first = await cache.getOrCreate(KEY_A, {} as never);
    const second = await cache.getOrCreate(KEY_A_GEN2, {} as never);

    expect(first).not.toBe(second);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  test("currentKey returns the cache key", async () => {
    const factory = createMockFactory();
    const cache = createEngineCache(factory);

    expect(cache.currentKey()).toBeUndefined();

    await cache.getOrCreate(KEY_A, {} as never);

    expect(cache.currentKey()).toEqual(KEY_A);
  });
});

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

describe("invalidation", () => {
  test("invalidate clears cached instance", async () => {
    const factory = createMockFactory();
    const cache = createEngineCache(factory);

    await cache.getOrCreate(KEY_A, {} as never);
    expect(cache.hasCached()).toBe(true);

    cache.invalidate();
    expect(cache.hasCached()).toBe(false);
    expect(cache.currentKey()).toBeUndefined();
  });

  test("getOrCreate after invalidate creates new instance", async () => {
    const factory = createMockFactory();
    const cache = createEngineCache(factory);

    const first = await cache.getOrCreate(KEY_A, {} as never);
    cache.invalidate();
    const second = await cache.getOrCreate(KEY_A, {} as never);

    expect(first).not.toBe(second);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  test("invalidate on empty cache is no-op", () => {
    const factory = createMockFactory();
    const cache = createEngineCache(factory);

    cache.invalidate(); // Should not throw
    expect(cache.hasCached()).toBe(false);
  });
});
