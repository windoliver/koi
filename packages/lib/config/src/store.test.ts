import { describe, expect, test } from "bun:test";
import { createConfigStore } from "./store.js";

interface TestConfig {
  readonly logLevel: string;
  readonly maxTurns: number;
}

describe("createConfigStore", () => {
  test("get() returns the initial value", () => {
    const store = createConfigStore<TestConfig>({ logLevel: "info", maxTurns: 25 });
    expect(store.get()).toEqual({ logLevel: "info", maxTurns: 25 });
  });

  test("initial value is frozen", () => {
    const store = createConfigStore<TestConfig>({ logLevel: "info", maxTurns: 25 });
    expect(Object.isFrozen(store.get())).toBe(true);
  });

  test("set() updates the value", () => {
    const store = createConfigStore<TestConfig>({ logLevel: "info", maxTurns: 25 });
    store.set({ logLevel: "debug", maxTurns: 50 });
    expect(store.get()).toEqual({ logLevel: "debug", maxTurns: 50 });
  });

  test("set() freezes the new value", () => {
    const store = createConfigStore<TestConfig>({ logLevel: "info", maxTurns: 25 });
    store.set({ logLevel: "debug", maxTurns: 50 });
    expect(Object.isFrozen(store.get())).toBe(true);
  });

  test("subscribe() fires on set()", () => {
    const store = createConfigStore<TestConfig>({ logLevel: "info", maxTurns: 25 });
    const calls: Array<{ readonly next: TestConfig; readonly prev: TestConfig }> = [];
    store.subscribe((next, prev) => {
      calls.push({ next, prev });
    });
    store.set({ logLevel: "debug", maxTurns: 50 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.next).toEqual({ logLevel: "debug", maxTurns: 50 });
    expect(calls[0]?.prev).toEqual({ logLevel: "info", maxTurns: 25 });
  });

  test("unsubscribe stops notifications", () => {
    const store = createConfigStore<TestConfig>({ logLevel: "info", maxTurns: 25 });
    let callCount = 0;
    const unsubscribe = store.subscribe(() => {
      callCount++;
    });
    store.set({ logLevel: "debug", maxTurns: 50 });
    expect(callCount).toBe(1);
    unsubscribe();
    store.set({ logLevel: "warn", maxTurns: 75 });
    expect(callCount).toBe(1);
  });

  test("multiple subscribers all fire", () => {
    const store = createConfigStore<TestConfig>({ logLevel: "info", maxTurns: 25 });
    let count1 = 0;
    let count2 = 0;
    store.subscribe(() => {
      count1++;
    });
    store.subscribe(() => {
      count2++;
    });
    store.set({ logLevel: "debug", maxTurns: 50 });
    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });

  test("get() returns new reference after set()", () => {
    const store = createConfigStore<TestConfig>({ logLevel: "info", maxTurns: 25 });
    const ref1 = store.get();
    store.set({ logLevel: "info", maxTurns: 25 });
    const ref2 = store.get();
    expect(ref1).not.toBe(ref2);
  });
});
