/**
 * Attestation cache tests — content hash-based verification cache behavior.
 */

import { describe, expect, test } from "bun:test";
import { createAttestationCache } from "./attestation-cache.js";

describe("createAttestationCache", () => {
  test("cache miss returns undefined", () => {
    const cache = createAttestationCache();
    expect(cache.get("nonexistent-hash")).toBeUndefined();
  });

  test("cache hit returns stored result", () => {
    const cache = createAttestationCache();
    cache.set("hash-001", true);

    const entry = cache.get("hash-001");
    expect(entry).toBeDefined();
    expect(entry?.valid).toBe(true);
    expect(entry?.verifiedAt).toBeGreaterThan(0);
  });

  test("stores invalid results too", () => {
    const cache = createAttestationCache();
    cache.set("bad-hash", false);

    const entry = cache.get("bad-hash");
    expect(entry).toBeDefined();
    expect(entry?.valid).toBe(false);
  });

  test("different content hashes have different entries", () => {
    const cache = createAttestationCache();
    cache.set("hash-a", true);
    cache.set("hash-b", false);

    expect(cache.get("hash-a")?.valid).toBe(true);
    expect(cache.get("hash-b")?.valid).toBe(false);
  });

  test("invalidation removes entry", () => {
    const cache = createAttestationCache();
    cache.set("hash-to-remove", true);
    expect(cache.get("hash-to-remove")).toBeDefined();

    cache.invalidate("hash-to-remove");
    expect(cache.get("hash-to-remove")).toBeUndefined();
  });

  test("invalidation of nonexistent key is no-op", () => {
    const cache = createAttestationCache();
    cache.invalidate("nonexistent");
    expect(cache.size()).toBe(0);
  });

  test("clear removes all entries", () => {
    const cache = createAttestationCache();
    cache.set("h1", true);
    cache.set("h2", true);
    cache.set("h3", false);
    expect(cache.size()).toBe(3);

    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get("h1")).toBeUndefined();
  });

  test("size tracks entry count", () => {
    const cache = createAttestationCache();
    expect(cache.size()).toBe(0);

    cache.set("a", true);
    expect(cache.size()).toBe(1);

    cache.set("b", true);
    expect(cache.size()).toBe(2);

    cache.invalidate("a");
    expect(cache.size()).toBe(1);
  });

  test("evicts oldest entry when capacity exceeded", () => {
    const cache = createAttestationCache(3);
    cache.set("first", true);
    cache.set("second", true);
    cache.set("third", true);
    expect(cache.size()).toBe(3);

    // Adding a 4th entry should evict "first" (LRU)
    cache.set("fourth", true);
    expect(cache.size()).toBe(3);
    expect(cache.get("first")).toBeUndefined();
    expect(cache.get("second")).toBeDefined();
    expect(cache.get("fourth")).toBeDefined();
  });

  test("get promotes entry to most recently used", () => {
    const cache = createAttestationCache(3);
    cache.set("a", true);
    cache.set("b", true);
    cache.set("c", true);

    // Access "a" to promote it — "b" becomes LRU
    cache.get("a");

    // Adding "d" should evict "b" (now LRU), not "a"
    cache.set("d", true);
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.get("d")).toBeDefined();
  });

  test("update existing entry does not increase size", () => {
    const cache = createAttestationCache(3);
    cache.set("a", true);
    cache.set("b", true);
    cache.set("a", false); // Update, not insert

    expect(cache.size()).toBe(2);
    expect(cache.get("a")?.valid).toBe(false);
  });
});
