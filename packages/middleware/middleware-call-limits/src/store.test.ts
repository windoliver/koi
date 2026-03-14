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

  test("decrement reduces count by 1", () => {
    const store = createInMemoryCallLimitStore();
    store.increment("key");
    store.increment("key");
    expect(store.decrement("key")).toBe(1);
    expect(store.get("key")).toBe(1);
  });

  test("decrement does not go below 0", () => {
    const store = createInMemoryCallLimitStore();
    expect(store.decrement("key")).toBe(0);
    expect(store.get("key")).toBe(0);
  });

  test("decrement from 1 removes key entirely", () => {
    const store = createInMemoryCallLimitStore();
    store.increment("key");
    store.decrement("key");
    expect(store.get("key")).toBe(0);
  });

  test("incrementIfBelow allows when current is below limit", () => {
    const store = createInMemoryCallLimitStore();
    const result = store.incrementIfBelow("key", 3);
    expect(result).toEqual({ allowed: true, current: 1 });
    expect(store.get("key")).toBe(1);
  });

  test("incrementIfBelow rejects when current equals limit", () => {
    const store = createInMemoryCallLimitStore();
    store.increment("key");
    store.increment("key");
    const result = store.incrementIfBelow("key", 2);
    expect(result).toEqual({ allowed: false, current: 2 });
    // Count should NOT have changed
    expect(store.get("key")).toBe(2);
  });

  test("incrementIfBelow rejects when current exceeds limit", () => {
    const store = createInMemoryCallLimitStore();
    store.increment("key");
    store.increment("key");
    store.increment("key");
    const result = store.incrementIfBelow("key", 2);
    expect(result).toEqual({ allowed: false, current: 3 });
  });

  test("incrementIfBelow with limit 0 rejects immediately", () => {
    const store = createInMemoryCallLimitStore();
    const result = store.incrementIfBelow("key", 0);
    expect(result).toEqual({ allowed: false, current: 0 });
  });

  test("incrementIfBelow increments atomically across successive calls", () => {
    const store = createInMemoryCallLimitStore();
    const r1 = store.incrementIfBelow("key", 3);
    const r2 = store.incrementIfBelow("key", 3);
    const r3 = store.incrementIfBelow("key", 3);
    const r4 = store.incrementIfBelow("key", 3);

    expect(r1).toEqual({ allowed: true, current: 1 });
    expect(r2).toEqual({ allowed: true, current: 2 });
    expect(r3).toEqual({ allowed: true, current: 3 });
    expect(r4).toEqual({ allowed: false, current: 3 });
  });
});
