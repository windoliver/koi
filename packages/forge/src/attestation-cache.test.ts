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
});
