import { describe, expect, test } from "bun:test";
import { createSpawnResultCache, spawnCacheKey } from "./spawn-result-cache.js";

describe("createSpawnResultCache", () => {
  test("returns undefined for unknown keys", () => {
    const cache = createSpawnResultCache(8);
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  test("stores and retrieves an entry", () => {
    const cache = createSpawnResultCache(8);
    cache.set("k1", "out-1");
    expect(cache.get("k1")).toBe("out-1");
    expect(cache.size()).toBe(1);
  });

  test("overwrites an existing key without growing size", () => {
    const cache = createSpawnResultCache(8);
    cache.set("k1", "first");
    cache.set("k1", "second");
    expect(cache.get("k1")).toBe("second");
    expect(cache.size()).toBe(1);
  });

  test("evicts oldest entry when at capacity", () => {
    const cache = createSpawnResultCache(2);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
    expect(cache.size()).toBe(2);
  });

  test("get promotes recency so the touched entry survives eviction", () => {
    const cache = createSpawnResultCache(2);
    cache.set("a", "1");
    cache.set("b", "2");
    // Touch "a" — now "b" is the oldest
    expect(cache.get("a")).toBe("1");
    cache.set("c", "3");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("1");
    expect(cache.get("c")).toBe("3");
  });

  test("rejects invalid capacities", () => {
    expect(() => createSpawnResultCache(0)).toThrow();
    expect(() => createSpawnResultCache(-1)).toThrow();
    expect(() => createSpawnResultCache(1.5)).toThrow();
  });
});

describe("spawnCacheKey", () => {
  test("returns key when context has a string task_id", () => {
    const key = spawnCacheKey("parent-1", "researcher", { task_id: "T-42" });
    expect(key).toBe("parent-1::researcher::T-42");
  });

  test("returns undefined without context", () => {
    expect(spawnCacheKey("parent-1", "researcher", undefined)).toBeUndefined();
  });

  test("returns undefined when task_id is missing", () => {
    expect(spawnCacheKey("parent-1", "researcher", { other: "x" })).toBeUndefined();
  });

  test("returns undefined when task_id is not a string", () => {
    expect(spawnCacheKey("parent-1", "researcher", { task_id: 123 })).toBeUndefined();
    expect(spawnCacheKey("parent-1", "researcher", { task_id: null })).toBeUndefined();
  });

  test("returns undefined when task_id is an empty string", () => {
    expect(spawnCacheKey("parent-1", "researcher", { task_id: "" })).toBeUndefined();
  });

  test("distinguishes calls by parentAgentId, agentName, and taskId", () => {
    const a = spawnCacheKey("parent-1", "researcher", { task_id: "T-1" });
    const b = spawnCacheKey("parent-2", "researcher", { task_id: "T-1" });
    const c = spawnCacheKey("parent-1", "coder", { task_id: "T-1" });
    const d = spawnCacheKey("parent-1", "researcher", { task_id: "T-2" });
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});
