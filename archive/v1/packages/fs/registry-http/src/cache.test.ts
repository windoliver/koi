import { describe, expect, test } from "bun:test";
import { createLruCache } from "./cache.js";

describe("createLruCache", () => {
  test("stores and retrieves values", () => {
    const cache = createLruCache<string>(10, 60_000);
    cache.set("a", "value-a");
    expect(cache.get("a")).toBe("value-a");
  });

  test("returns undefined for missing keys", () => {
    const cache = createLruCache<string>(10, 60_000);
    expect(cache.get("missing")).toBeUndefined();
  });

  test("evicts oldest entry when at capacity", () => {
    const cache = createLruCache<string>(2, 60_000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3"); // evicts "a"

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
  });

  test("accessing an entry moves it to most recent", () => {
    const cache = createLruCache<string>(2, 60_000);
    cache.set("a", "1");
    cache.set("b", "2");

    // Access "a" — makes it most recently used
    cache.get("a");

    cache.set("c", "3"); // should evict "b" (oldest) not "a"
    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("3");
  });

  test("expires entries after TTL", () => {
    let now = 1000;
    const cache = createLruCache<string>(10, 100, () => now);

    cache.set("a", "value");
    expect(cache.get("a")).toBe("value");

    now = 1101; // past TTL
    expect(cache.get("a")).toBeUndefined();
  });

  test("delete removes specific entry", () => {
    const cache = createLruCache<string>(10, 60_000);
    cache.set("a", "1");
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
  });

  test("clear removes all entries", () => {
    const cache = createLruCache<string>(10, 60_000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  test("size returns current entry count", () => {
    const cache = createLruCache<string>(10, 60_000);
    expect(cache.size()).toBe(0);
    cache.set("a", "1");
    expect(cache.size()).toBe(1);
    cache.set("b", "2");
    expect(cache.size()).toBe(2);
  });

  test("overwriting a key updates the value and position", () => {
    const cache = createLruCache<string>(2, 60_000);
    cache.set("a", "old");
    cache.set("b", "2");
    cache.set("a", "new"); // update "a" — moves to end

    cache.set("c", "3"); // should evict "b" (oldest)
    expect(cache.get("a")).toBe("new");
    expect(cache.get("b")).toBeUndefined();
  });
});
