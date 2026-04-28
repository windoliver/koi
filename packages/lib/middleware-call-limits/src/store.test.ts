import { describe, expect, test } from "bun:test";
import { createInMemoryCallLimitStore } from "./store.js";

describe("createInMemoryCallLimitStore", () => {
  test("get returns 0 for missing keys", () => {
    const store = createInMemoryCallLimitStore();
    expect(store.get("none")).toBe(0);
  });

  test("increment / decrement / reset round-trip", () => {
    const store = createInMemoryCallLimitStore();
    expect(store.increment("k")).toBe(1);
    expect(store.increment("k")).toBe(2);
    expect(store.decrement("k")).toBe(1);
    store.reset("k");
    expect(store.get("k")).toBe(0);
  });

  test("decrement floors at 0 and removes key", () => {
    const store = createInMemoryCallLimitStore();
    expect(store.decrement("k")).toBe(0);
    expect(store.get("k")).toBe(0);
  });

  test("incrementIfBelow allows below limit", () => {
    const store = createInMemoryCallLimitStore();
    const r = store.incrementIfBelow("k", 2);
    expect(r).toEqual({ allowed: true, current: 1 });
    const r2 = store.incrementIfBelow("k", 2);
    expect(r2).toEqual({ allowed: true, current: 2 });
  });

  test("incrementIfBelow blocks at limit and does not increment", () => {
    const store = createInMemoryCallLimitStore();
    store.incrementIfBelow("k", 1);
    const r = store.incrementIfBelow("k", 1);
    expect(r).toEqual({ allowed: false, current: 1 });
    expect(store.get("k")).toBe(1);
  });
});
