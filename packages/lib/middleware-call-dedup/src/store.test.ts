import { describe, expect, test } from "bun:test";
import { createInMemoryDedupStore } from "./store.js";
import type { CacheEntry } from "./types.js";

function entry(out: string, expiresAt = 9_999_999_999): CacheEntry {
  return { response: { output: out }, expiresAt };
}

describe("createInMemoryDedupStore", () => {
  test("get/set/delete round-trip", () => {
    const store = createInMemoryDedupStore(10);
    expect(store.get("k")).toBeUndefined();
    store.set("k", entry("v"));
    expect((store.get("k") as CacheEntry).response.output).toBe("v");
    expect(store.delete("k")).toBe(true);
    expect(store.get("k")).toBeUndefined();
  });

  test("LRU evicts oldest at capacity", () => {
    const store = createInMemoryDedupStore(2);
    store.set("a", entry("1"));
    store.set("b", entry("2"));
    store.set("c", entry("3"));
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toBeDefined();
    expect(store.get("c")).toBeDefined();
  });

  test("get promotes entry (LRU last)", () => {
    const store = createInMemoryDedupStore(2);
    store.set("a", entry("1"));
    store.set("b", entry("2"));
    // Promote 'a'
    store.get("a");
    store.set("c", entry("3"));
    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")).toBeDefined();
    expect(store.get("c")).toBeDefined();
  });

  test("size + clear", () => {
    const store = createInMemoryDedupStore(10);
    store.set("a", entry("1"));
    store.set("b", entry("2"));
    expect(store.size()).toBe(2);
    store.clear();
    expect(store.size()).toBe(0);
  });
});
