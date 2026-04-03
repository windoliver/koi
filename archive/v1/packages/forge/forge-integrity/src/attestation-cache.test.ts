/**
 * Tests for createAttestationCache — LRU-capped verification cache.
 */

import { describe, expect, test } from "bun:test";
import { createAttestationCache } from "./attestation-cache.js";

// ---------------------------------------------------------------------------
// createAttestationCache
// ---------------------------------------------------------------------------

describe("createAttestationCache", () => {
  test("get returns undefined for missing", () => {
    const cache = createAttestationCache();
    expect(cache.get("sha256:nonexistent")).toBeUndefined();
  });

  test("set + get round-trip", () => {
    const cache = createAttestationCache();
    cache.set("sha256:abc", true);

    const entry = cache.get("sha256:abc");
    expect(entry).toBeDefined();
    expect(entry?.valid).toBe(true);
    expect(typeof entry?.verifiedAt).toBe("number");
  });

  test("LRU eviction at capacity", () => {
    const cache = createAttestationCache(3);
    cache.set("hash-a", true);
    cache.set("hash-b", true);
    cache.set("hash-c", true);

    // Cache is full (3/3). Adding another should evict the oldest (hash-a).
    cache.set("hash-d", true);

    expect(cache.get("hash-a")).toBeUndefined();
    expect(cache.get("hash-b")).toBeDefined();
    expect(cache.get("hash-c")).toBeDefined();
    expect(cache.get("hash-d")).toBeDefined();
    expect(cache.size()).toBe(3);
  });

  test("LRU eviction respects access order", () => {
    const cache = createAttestationCache(3);
    cache.set("hash-a", true);
    cache.set("hash-b", true);
    cache.set("hash-c", true);

    // Access hash-a to move it to most-recently-used
    cache.get("hash-a");

    // Adding hash-d should evict hash-b (least recently used), not hash-a
    cache.set("hash-d", true);

    expect(cache.get("hash-a")).toBeDefined();
    expect(cache.get("hash-b")).toBeUndefined();
    expect(cache.get("hash-c")).toBeDefined();
    expect(cache.get("hash-d")).toBeDefined();
  });

  test("invalidate removes entry", () => {
    const cache = createAttestationCache();
    cache.set("sha256:target", true);
    cache.set("sha256:other", false);

    cache.invalidate("sha256:target");

    expect(cache.get("sha256:target")).toBeUndefined();
    expect(cache.get("sha256:other")).toBeDefined();
    expect(cache.size()).toBe(1);
  });

  test("clear removes all", () => {
    const cache = createAttestationCache();
    cache.set("hash-1", true);
    cache.set("hash-2", false);
    cache.set("hash-3", true);

    expect(cache.size()).toBe(3);

    cache.clear();

    expect(cache.size()).toBe(0);
    expect(cache.get("hash-1")).toBeUndefined();
    expect(cache.get("hash-2")).toBeUndefined();
    expect(cache.get("hash-3")).toBeUndefined();
  });

  test("size tracks correctly", () => {
    const cache = createAttestationCache();

    expect(cache.size()).toBe(0);

    cache.set("a", true);
    expect(cache.size()).toBe(1);

    cache.set("b", false);
    expect(cache.size()).toBe(2);

    cache.invalidate("a");
    expect(cache.size()).toBe(1);

    cache.set("b", true); // update existing — size unchanged
    expect(cache.size()).toBe(1);

    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
