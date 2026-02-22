import { describe, expect, mock, test } from "bun:test";
import type { Embedder } from "@koi/core";
import { createCachedEmbedder } from "./embedder-cache.js";

function makeMockEmbedder(): Embedder & { readonly callCount: () => number } {
  let calls = 0;
  const embedFn = mock(async (text: string): Promise<readonly number[]> => {
    calls++;
    // Deterministic embedding based on text length
    return [text.length, text.charCodeAt(0) ?? 0, 0.5];
  });
  const embedManyFn = mock(
    async (texts: readonly string[]): Promise<readonly (readonly number[])[]> => {
      calls += texts.length;
      return texts.map((t) => [t.length, t.charCodeAt(0) ?? 0, 0.5]);
    },
  );
  return {
    embed: embedFn,
    embedMany: embedManyFn,
    dimensions: 3,
    callCount: () => calls,
  };
}

describe("createCachedEmbedder", () => {
  test("delegates to inner embedder on cache miss", async () => {
    const inner = makeMockEmbedder();
    const cached = createCachedEmbedder({ embedder: inner });

    const result = await cached.embed("hello");
    expect(result).toEqual([5, 104, 0.5]);
    expect(cached.stats).toEqual({ hits: 0, misses: 1, size: 1 });
  });

  test("returns cached result on cache hit", async () => {
    const inner = makeMockEmbedder();
    const cached = createCachedEmbedder({ embedder: inner });

    await cached.embed("hello");
    const result = await cached.embed("hello");
    expect(result).toEqual([5, 104, 0.5]);
    expect(cached.stats).toEqual({ hits: 1, misses: 1, size: 1 });
    expect(inner.callCount()).toBe(1); // Only one actual embed call
  });

  test("embedMany splits hits and misses", async () => {
    const inner = makeMockEmbedder();
    const cached = createCachedEmbedder({ embedder: inner });

    // Pre-cache "hello"
    await cached.embed("hello");

    // embedMany with one hit ("hello") and one miss ("world")
    const results = await cached.embedMany(["hello", "world"]);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual([5, 104, 0.5]);
    expect(results[1]).toEqual([5, 119, 0.5]);
    expect(cached.stats.hits).toBe(1); // "hello" hit from embedMany
    expect(cached.stats.misses).toBe(2); // 1 from embed("hello") + 1 from embedMany("world")
  });

  test("LRU eviction when maxSize exceeded", async () => {
    const inner = makeMockEmbedder();
    const cached = createCachedEmbedder({ embedder: inner, maxSize: 2 });

    await cached.embed("a");
    await cached.embed("b");
    expect(cached.stats.size).toBe(2);

    // This should evict "a" (oldest)
    await cached.embed("c");
    expect(cached.stats.size).toBe(2);

    // "a" is evicted — should be a miss
    await cached.embed("a");
    expect(cached.stats.misses).toBe(4); // a, b, c, a again
  });

  test("LRU touch moves entry to end", async () => {
    const inner = makeMockEmbedder();
    const cached = createCachedEmbedder({ embedder: inner, maxSize: 2 });

    await cached.embed("a");
    await cached.embed("b");

    // Touch "a" — now "b" is the oldest
    await cached.embed("a");

    // Insert "c" — should evict "b" (oldest)
    await cached.embed("c");

    // "a" should still be cached
    await cached.embed("a");
    expect(cached.stats.hits).toBe(2); // second "a" + third "a"
  });

  test("exposes correct dimensions", () => {
    const inner = makeMockEmbedder();
    const cached = createCachedEmbedder({ embedder: inner });
    expect(cached.dimensions).toBe(3);
  });

  test("embedMany with all hits avoids calling inner embedMany", async () => {
    const inner = makeMockEmbedder();
    const cached = createCachedEmbedder({ embedder: inner });

    await cached.embed("a");
    await cached.embed("b");

    const initialCalls = inner.callCount();
    await cached.embedMany(["a", "b"]);
    expect(inner.callCount()).toBe(initialCalls); // No new calls
    expect(cached.stats.hits).toBe(2);
  });
});
