import { describe, expect, test } from "bun:test";
import { createInMemoryDedupStore } from "./store.js";
import type { CacheEntry } from "./types.js";

function entry(output: string, expiresAt: number): CacheEntry {
  return { response: { output }, expiresAt };
}

describe("createInMemoryDedupStore", () => {
  test("get returns undefined for missing key", () => {
    const store = createInMemoryDedupStore(10);
    expect(store.get("missing")).toBeUndefined();
  });

  test("set + get returns cached entry", () => {
    const store = createInMemoryDedupStore(10);
    const e = entry("hello", 9999);
    store.set("k1", e);
    expect(store.get("k1")).toEqual(e);
  });

  test("delete removes existing key and returns true", () => {
    const store = createInMemoryDedupStore(10);
    store.set("k1", entry("a", 1));
    expect(store.delete("k1")).toBe(true);
    expect(store.get("k1")).toBeUndefined();
  });

  test("delete returns false for missing key", () => {
    const store = createInMemoryDedupStore(10);
    expect(store.delete("nope")).toBe(false);
  });

  test("evicts oldest entry when at capacity", () => {
    const store = createInMemoryDedupStore(2);
    store.set("a", entry("1", 100));
    store.set("b", entry("2", 100));
    // At capacity — inserting c should evict a (oldest)
    store.set("c", entry("3", 100));
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toBeDefined();
    expect(store.get("c")).toBeDefined();
  });

  test("LRU promotion: accessed entry survives eviction", () => {
    const store = createInMemoryDedupStore(2);
    store.set("a", entry("1", 100));
    store.set("b", entry("2", 100));
    // Access a to promote it — b is now oldest
    store.get("a");
    store.set("c", entry("3", 100));
    expect(store.get("a")).toBeDefined();
    expect(store.get("b")).toBeUndefined();
    expect(store.get("c")).toBeDefined();
  });

  test("size returns correct count", () => {
    const store = createInMemoryDedupStore(10);
    expect(store.size()).toBe(0);
    store.set("a", entry("1", 100));
    store.set("b", entry("2", 100));
    expect(store.size()).toBe(2);
  });

  test("clear empties all entries", () => {
    const store = createInMemoryDedupStore(10);
    store.set("a", entry("1", 100));
    store.set("b", entry("2", 100));
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.get("a")).toBeUndefined();
  });
});
