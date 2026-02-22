import { describe, expect, mock, test } from "bun:test";
import { selectConfig } from "./select.js";
import { createConfigStore } from "./store.js";

describe("selectConfig", () => {
  test("fires listener when selected slice changes", () => {
    const store = createConfigStore({ a: 1, b: "hello" });
    const fn = mock(() => {});
    selectConfig(store, (c) => c.a, fn);
    store.set({ a: 2, b: "hello" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2, 1);
  });

  test("does not fire listener when selected slice is unchanged", () => {
    const store = createConfigStore({ a: 1, b: "hello" });
    const fn = mock(() => {});
    selectConfig(store, (c) => c.a, fn);
    store.set({ a: 1, b: "world" });
    expect(fn).not.toHaveBeenCalled();
  });

  test("unsubscribe stops notifications", () => {
    const store = createConfigStore({ a: 1, b: "hello" });
    const fn = mock(() => {});
    const unsub = selectConfig(store, (c) => c.a, fn);
    unsub();
    store.set({ a: 99, b: "hello" });
    expect(fn).not.toHaveBeenCalled();
  });

  test("works with nested object selection (reference equality)", () => {
    const nested = { x: 1 };
    const store = createConfigStore({ nested, flag: true });
    const fn = mock(() => {});
    selectConfig(store, (c) => c.nested, fn);
    // Same nested reference → should not fire
    store.set({ nested, flag: false });
    expect(fn).not.toHaveBeenCalled();
  });

  test("fires when nested reference changes", () => {
    const store = createConfigStore({ nested: { x: 1 }, flag: true });
    const fn = mock(() => {});
    selectConfig(store, (c) => c.nested, fn);
    store.set({ nested: { x: 2 }, flag: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
