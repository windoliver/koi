import { describe, expect, test } from "bun:test";
import { createHttpCache } from "./http-cache.js";

describe("createHttpCache", () => {
  test("get returns undefined for missing key", () => {
    const cache = createHttpCache();
    expect(cache.get("https://example.com/missing")).toBeUndefined();
  });

  test("set + get round-trip works", () => {
    const cache = createHttpCache();
    const response = { body: { items: [] }, cachedAt: Date.now() };
    cache.set("https://example.com/search", response);

    const result = cache.get("https://example.com/search");
    expect(result).toBeDefined();
    expect(result?.body).toEqual({ items: [] });
  });

  test("stores and retrieves etag", () => {
    const cache = createHttpCache();
    const response = {
      etag: '"abc123"',
      body: { data: "test" },
      cachedAt: Date.now(),
    };
    cache.set("https://example.com/resource", response);

    const result = cache.get("https://example.com/resource");
    expect(result?.etag).toBe('"abc123"');
  });

  test("expired entries return undefined", () => {
    let now = 1000;
    const cache = createHttpCache({ ttlMs: 100, clock: () => now });

    cache.set("https://example.com/a", {
      body: "value",
      cachedAt: now,
    });
    expect(cache.get("https://example.com/a")).toBeDefined();

    // Advance past TTL
    now = 1100;
    expect(cache.get("https://example.com/a")).toBeUndefined();
  });

  test("LRU eviction at capacity", () => {
    const cache = createHttpCache({ maxEntries: 2 });

    cache.set("https://example.com/a", { body: "a", cachedAt: Date.now() });
    cache.set("https://example.com/b", { body: "b", cachedAt: Date.now() });
    cache.set("https://example.com/c", { body: "c", cachedAt: Date.now() });

    // "a" should be evicted (oldest)
    expect(cache.get("https://example.com/a")).toBeUndefined();
    expect(cache.get("https://example.com/b")).toBeDefined();
    expect(cache.get("https://example.com/c")).toBeDefined();
  });

  test("accessing an entry makes it most-recently-used", () => {
    const cache = createHttpCache({ maxEntries: 2 });

    cache.set("https://example.com/a", { body: "a", cachedAt: Date.now() });
    cache.set("https://example.com/b", { body: "b", cachedAt: Date.now() });

    // Access "a" — moves to MRU position
    cache.get("https://example.com/a");

    // Insert "c" — should evict "b" (LRU), not "a"
    cache.set("https://example.com/c", { body: "c", cachedAt: Date.now() });

    expect(cache.get("https://example.com/a")).toBeDefined();
    expect(cache.get("https://example.com/b")).toBeUndefined();
    expect(cache.get("https://example.com/c")).toBeDefined();
  });

  test("clear removes all entries", () => {
    const cache = createHttpCache();

    cache.set("https://example.com/a", { body: "a", cachedAt: Date.now() });
    cache.set("https://example.com/b", { body: "b", cachedAt: Date.now() });
    expect(cache.size()).toBe(2);

    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get("https://example.com/a")).toBeUndefined();
    expect(cache.get("https://example.com/b")).toBeUndefined();
  });

  test("size returns current entry count", () => {
    const cache = createHttpCache();
    expect(cache.size()).toBe(0);

    cache.set("https://example.com/a", { body: "a", cachedAt: Date.now() });
    expect(cache.size()).toBe(1);

    cache.set("https://example.com/b", { body: "b", cachedAt: Date.now() });
    expect(cache.size()).toBe(2);
  });

  test("overwriting a key updates value and position", () => {
    const cache = createHttpCache({ maxEntries: 2 });

    cache.set("https://example.com/a", { body: "old", cachedAt: Date.now() });
    cache.set("https://example.com/b", { body: "b", cachedAt: Date.now() });

    // Update "a" — moves to MRU
    cache.set("https://example.com/a", { body: "new", cachedAt: Date.now() });

    // Insert "c" — should evict "b"
    cache.set("https://example.com/c", { body: "c", cachedAt: Date.now() });

    expect(cache.get("https://example.com/a")?.body).toBe("new");
    expect(cache.get("https://example.com/b")).toBeUndefined();
  });
});
