import { describe, expect, mock, test } from "bun:test";
import { createConfigStore } from "./store.js";

describe("createConfigStore", () => {
  test("get() returns initial value", () => {
    const store = createConfigStore({ x: 1 });
    expect(store.get()).toEqual({ x: 1 });
  });

  test("get() returns frozen object", () => {
    const store = createConfigStore({ x: 1 });
    expect(Object.isFrozen(store.get())).toBe(true);
  });

  test("get() returns same reference on repeated calls", () => {
    const store = createConfigStore({ x: 1 });
    expect(store.get()).toBe(store.get());
  });

  test("set() updates the value returned by get()", () => {
    const store = createConfigStore({ x: 1 });
    store.set({ x: 42 });
    expect(store.get()).toEqual({ x: 42 });
  });

  test("set() freezes the new value", () => {
    const store = createConfigStore({ x: 1 });
    store.set({ x: 42 });
    expect(Object.isFrozen(store.get())).toBe(true);
  });

  test("subscribe() is called synchronously on set()", () => {
    const store = createConfigStore({ x: 1 });
    const fn = mock(() => {});
    store.subscribe(fn);
    store.set({ x: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ x: 2 }, { x: 1 });
  });

  test("subscribe() is not called when no set()", () => {
    const store = createConfigStore({ x: 1 });
    const fn = mock(() => {});
    store.subscribe(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  test("unsubscribe removes the listener", () => {
    const store = createConfigStore({ x: 1 });
    const fn = mock(() => {});
    const unsub = store.subscribe(fn);
    unsub();
    store.set({ x: 2 });
    expect(fn).not.toHaveBeenCalled();
  });

  test("multiple subscribers all get notified", () => {
    const store = createConfigStore({ x: 1 });
    const fn1 = mock(() => {});
    const fn2 = mock(() => {});
    store.subscribe(fn1);
    store.subscribe(fn2);
    store.set({ x: 2 });
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  test("does not mutate initial value object", () => {
    const init = { x: 1 };
    createConfigStore(init);
    expect(Object.isFrozen(init)).toBe(false);
  });
});
