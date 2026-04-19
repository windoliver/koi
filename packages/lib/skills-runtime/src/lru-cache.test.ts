/**
 * LRU cache unit tests (issue #1642).
 *
 * Covers:
 * - Unbounded sentinel (Infinity): never evicts, preserves legacy behavior
 * - Bounded cache: evicts least-recently-used when over capacity
 * - Access order: get() promotes entry to most-recently-used
 * - Invalidation: delete() is observable via the eviction callback
 * - Full clear: clear() reports all entries as evicted
 */
import { describe, expect, test } from "bun:test";
import type { EvictionEvent } from "./lru-cache.js";
import { createBodyCache } from "./lru-cache.js";

describe("createBodyCache — unbounded", () => {
  test("retains every entry when max is Infinity", () => {
    const cache = createBodyCache<string>({ max: Number.POSITIVE_INFINITY });
    for (let i = 0; i < 100; i++) cache.set(`k${i}`, `v${i}`);
    expect(cache.size).toBe(100);
    expect(cache.get("k0")).toBe("v0");
    expect(cache.get("k99")).toBe("v99");
  });

  test("never fires evict callback for LRU reasons when unbounded", () => {
    const events: EvictionEvent[] = [];
    const cache = createBodyCache<string>({
      max: Number.POSITIVE_INFINITY,
      onEvict: (e) => events.push(e),
    });
    for (let i = 0; i < 10; i++) cache.set(`k${i}`, `v${i}`);
    expect(events).toEqual([]);
  });
});

describe("createBodyCache — bounded", () => {
  test("evicts least-recently-used when over capacity", () => {
    const events: EvictionEvent[] = [];
    const cache = createBodyCache<string>({
      max: 3,
      onEvict: (e) => events.push(e),
    });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    cache.set("d", "4"); // evicts "a"

    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(events).toEqual([{ key: "a", reason: "lru" }]);
  });

  test("get() promotes entry to most-recently-used", () => {
    const events: EvictionEvent[] = [];
    const cache = createBodyCache<string>({
      max: 3,
      onEvict: (e) => events.push(e),
    });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    // Touch "a" — it is now MRU; "b" is now LRU.
    cache.get("a");
    cache.set("d", "4"); // must evict "b", not "a"

    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBeUndefined();
    expect(events).toEqual([{ key: "b", reason: "lru" }]);
  });

  test("re-setting an existing key refreshes recency, not size", () => {
    const cache = createBodyCache<string>({ max: 2 });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("a", "1-bis"); // update existing — no eviction, a becomes MRU
    cache.set("c", "3"); // evicts b (now LRU), not a

    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBe("1-bis");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("3");
  });

  test("set honors a max of 1", () => {
    const events: EvictionEvent[] = [];
    const cache = createBodyCache<string>({
      max: 1,
      onEvict: (e) => events.push(e),
    });
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(events).toEqual([{ key: "a", reason: "lru" }]);
  });

  test("max of 0 is treated as unbounded to avoid a thrashing corner case", () => {
    // Zero-sized caches produce a useless runtime. Normalize upward.
    const cache = createBodyCache<string>({ max: 0 });
    cache.set("a", "1");
    expect(cache.get("a")).toBe("1");
  });

  test("negative max is normalized to unbounded", () => {
    const cache = createBodyCache<string>({ max: -5 });
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.size).toBe(2);
  });
});

describe("createBodyCache — delete & clear", () => {
  test("delete() reports the removed entry with reason 'invalidate'", () => {
    const events: EvictionEvent[] = [];
    const cache = createBodyCache<string>({
      max: 5,
      onEvict: (e) => events.push(e),
    });
    cache.set("a", "1");
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(events).toEqual([{ key: "a", reason: "invalidate" }]);
  });

  test("delete() for a missing key is a no-op", () => {
    const events: EvictionEvent[] = [];
    const cache = createBodyCache<string>({
      max: 5,
      onEvict: (e) => events.push(e),
    });
    cache.delete("missing");
    expect(events).toEqual([]);
  });

  test("clear() reports every entry as invalidated", () => {
    const events: EvictionEvent[] = [];
    const cache = createBodyCache<string>({
      max: 5,
      onEvict: (e) => events.push(e),
    });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.size).toBe(0);
    // Order-independent check — clearing iteration order is an implementation detail.
    expect(events.length).toBe(2);
    expect(events).toContainEqual({ key: "a", reason: "invalidate" });
    expect(events).toContainEqual({ key: "b", reason: "invalidate" });
  });

  test("clear() on an empty cache fires no events", () => {
    const events: EvictionEvent[] = [];
    const cache = createBodyCache<string>({
      max: 5,
      onEvict: (e) => events.push(e),
    });
    cache.clear();
    expect(events).toEqual([]);
  });
});
