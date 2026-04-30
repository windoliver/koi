import { describe, expect, test } from "bun:test";
import { createLru } from "./lru.js";

describe("createLru", () => {
  test("set + get", () => {
    const lru = createLru<string, number>(3);
    lru.set("a", 1);
    expect(lru.get("a")).toBe(1);
  });

  test("evicts oldest when over capacity", () => {
    const lru = createLru<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(lru.has("a")).toBe(false);
    expect(lru.has("b")).toBe(true);
    expect(lru.has("c")).toBe(true);
  });

  test("get refreshes recency", () => {
    const lru = createLru<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a");
    lru.set("c", 3);
    expect(lru.has("a")).toBe(true);
    expect(lru.has("b")).toBe(false);
  });

  test("size is bounded", () => {
    const lru = createLru<number, number>(10);
    for (let i = 0; i < 100; i++) lru.set(i, i);
    expect(lru.size()).toBe(10);
  });
});
