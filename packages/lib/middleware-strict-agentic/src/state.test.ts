import { describe, expect, test } from "bun:test";
import { createStateStore } from "./state.js";

describe("createStateStore", () => {
  test("recordTurn / readTurn round-trips", () => {
    const store = createStateStore();
    store.recordTurn("s1", "t1", { toolCallCount: 2, outputText: "hi" });
    expect(store.readTurn("t1")).toEqual({ toolCallCount: 2, outputText: "hi" });
  });

  test("readTurn returns undefined for missing id", () => {
    const store = createStateStore();
    expect(store.readTurn("missing")).toBeUndefined();
  });

  test("clearTurn removes entry", () => {
    const store = createStateStore();
    store.recordTurn("s1", "t1", { toolCallCount: 0, outputText: "" });
    store.clearTurn("t1");
    expect(store.readTurn("t1")).toBeUndefined();
  });

  test("incrementBlocks starts at 1 and increases", () => {
    const store = createStateStore();
    expect(store.incrementBlocks("s1")).toBe(1);
    expect(store.incrementBlocks("s1")).toBe(2);
    expect(store.incrementBlocks("s1")).toBe(3);
  });

  test("block counts are isolated by session", () => {
    const store = createStateStore();
    expect(store.incrementBlocks("sA")).toBe(1);
    expect(store.incrementBlocks("sB")).toBe(1);
    expect(store.incrementBlocks("sA")).toBe(2);
  });

  test("resetBlocks clears session counter", () => {
    const store = createStateStore();
    store.incrementBlocks("s1");
    store.incrementBlocks("s1");
    store.resetBlocks("s1");
    expect(store.incrementBlocks("s1")).toBe(1);
  });

  test("getBlockCount returns current counter (0 when unset)", () => {
    const store = createStateStore();
    expect(store.getBlockCount("s1")).toBe(0);
    store.incrementBlocks("s1");
    expect(store.getBlockCount("s1")).toBe(1);
  });

  test("clearSession drops block counter AND all outstanding turn states for that session", () => {
    // Regression: onAfterTurn may never fire if a session ends abnormally
    // (cancellation, crash, transport abort). clearSession must purge turn
    // state too, keyed via the recordTurn sessionId argument.
    const store = createStateStore();
    store.incrementBlocks("sA");
    store.recordTurn("sA", "t-sA-1", { toolCallCount: 1, outputText: "a" });
    store.recordTurn("sA", "t-sA-2", { toolCallCount: 0, outputText: "b" });
    store.recordTurn("sB", "t-sB-1", { toolCallCount: 1, outputText: "c" });

    store.clearSession("sA");

    expect(store.getBlockCount("sA")).toBe(0);
    expect(store.readTurn("t-sA-1")).toBeUndefined();
    expect(store.readTurn("t-sA-2")).toBeUndefined();
    // Other sessions' turns are unaffected.
    expect(store.readTurn("t-sB-1")).toEqual({ toolCallCount: 1, outputText: "c" });
  });
});
