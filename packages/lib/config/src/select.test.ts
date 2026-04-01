import { describe, expect, test } from "bun:test";
import { selectConfig } from "./select.js";
import { createConfigStore } from "./store.js";

interface TestConfig {
  readonly limits: { readonly maxTurns: number };
  readonly logLevel: string;
}

describe("selectConfig", () => {
  test("fires when selected slice changes", () => {
    const store = createConfigStore<TestConfig>({
      limits: { maxTurns: 25 },
      logLevel: "info",
    });
    const calls: Array<{ readonly next: string; readonly prev: string }> = [];
    selectConfig(
      store,
      (c) => c.logLevel,
      (next, prev) => {
        calls.push({ next, prev });
      },
    );
    store.set({ limits: { maxTurns: 25 }, logLevel: "debug" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.next).toBe("debug");
    expect(calls[0]?.prev).toBe("info");
  });

  test("does not fire when selected slice is same reference", () => {
    const limits = { maxTurns: 25 };
    const store = createConfigStore<TestConfig>({
      limits,
      logLevel: "info",
    });
    let callCount = 0;
    selectConfig(
      store,
      (c) => c.limits,
      () => {
        callCount++;
      },
    );
    // Change logLevel but keep same limits reference
    store.set({ limits, logLevel: "debug" });
    expect(callCount).toBe(0);
  });

  test("fires when object slice has new reference", () => {
    const store = createConfigStore<TestConfig>({
      limits: { maxTurns: 25 },
      logLevel: "info",
    });
    let callCount = 0;
    selectConfig(
      store,
      (c) => c.limits,
      () => {
        callCount++;
      },
    );
    store.set({ limits: { maxTurns: 50 }, logLevel: "info" });
    expect(callCount).toBe(1);
  });

  test("unsubscribe stops notifications", () => {
    const store = createConfigStore<TestConfig>({
      limits: { maxTurns: 25 },
      logLevel: "info",
    });
    let callCount = 0;
    const unsub = selectConfig(
      store,
      (c) => c.logLevel,
      () => {
        callCount++;
      },
    );
    store.set({ limits: { maxTurns: 25 }, logLevel: "debug" });
    expect(callCount).toBe(1);
    unsub();
    store.set({ limits: { maxTurns: 25 }, logLevel: "error" });
    expect(callCount).toBe(1);
  });
});
