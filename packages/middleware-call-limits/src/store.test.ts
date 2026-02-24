import { describe, expect, test } from "bun:test";
import { createInMemoryCallLimitStore } from "./store.js";

describe("createInMemoryCallLimitStore", () => {
  test("get returns 0 for unknown key", () => {
    const store = createInMemoryCallLimitStore();
    expect(store.get("unknown")).toBe(0);
  });

  test("increment returns 1 on first call", () => {
    const store = createInMemoryCallLimitStore();
    expect(store.increment("key")).toBe(1);
  });

  test("increment accumulates across calls", () => {
    const store = createInMemoryCallLimitStore();
    store.increment("key");
    store.increment("key");
    expect(store.increment("key")).toBe(3);
  });

  test("get reflects incremented value", () => {
    const store = createInMemoryCallLimitStore();
    store.increment("key");
    store.increment("key");
    expect(store.get("key")).toBe(2);
  });

  test("reset clears the count for a key", () => {
    const store = createInMemoryCallLimitStore();
    store.increment("key");
    store.increment("key");
    store.reset("key");
    expect(store.get("key")).toBe(0);
  });

  test("reset on unknown key is a no-op", () => {
    const store = createInMemoryCallLimitStore();
    store.reset("nonexistent");
    expect(store.get("nonexistent")).toBe(0);
  });

  test("keys are isolated from each other", () => {
    const store = createInMemoryCallLimitStore();
    store.increment("a");
    store.increment("a");
    store.increment("b");
    expect(store.get("a")).toBe(2);
    expect(store.get("b")).toBe(1);
  });

  test("separate store instances are independent", () => {
    const store1 = createInMemoryCallLimitStore();
    const store2 = createInMemoryCallLimitStore();
    store1.increment("key");
    store1.increment("key");
    expect(store1.get("key")).toBe(2);
    expect(store2.get("key")).toBe(0);
  });
});
