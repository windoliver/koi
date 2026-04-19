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

  test("incrementBlocks starts at 1 and increases within a run", () => {
    const store = createStateStore();
    expect(store.incrementBlocks("s1", "r1")).toBe(1);
    expect(store.incrementBlocks("s1", "r1")).toBe(2);
    expect(store.incrementBlocks("s1", "r1")).toBe(3);
  });

  test("block counts are isolated by runId — different runs never share a counter", () => {
    const store = createStateStore();
    expect(store.incrementBlocks("s1", "runA")).toBe(1);
    expect(store.incrementBlocks("s1", "runB")).toBe(1);
    expect(store.incrementBlocks("s1", "runA")).toBe(2);
  });

  test("resetBlocks clears counter for that run", () => {
    const store = createStateStore();
    store.incrementBlocks("s1", "r1");
    store.incrementBlocks("s1", "r1");
    store.resetBlocks("r1");
    expect(store.incrementBlocks("s1", "r1")).toBe(1);
  });

  test("getBlockCount returns current counter (0 when unset)", () => {
    const store = createStateStore();
    expect(store.getBlockCount("r1")).toBe(0);
    store.incrementBlocks("s1", "r1");
    expect(store.getBlockCount("r1")).toBe(1);
  });

  test("clearSession drops ALL run counters + turn states for that session", () => {
    // Regression: onAfterTurn may never fire if a session ends abnormally.
    // clearSession must purge both turn states AND run counters keyed to
    // the session (reverse indexes in both directions).
    const store = createStateStore();
    store.incrementBlocks("sA", "sA-r1");
    store.incrementBlocks("sA", "sA-r2");
    store.recordTurn("sA", "t-sA-1", { toolCallCount: 1, outputText: "a" });
    store.recordTurn("sA", "t-sA-2", { toolCallCount: 0, outputText: "b" });
    store.incrementBlocks("sB", "sB-r1");
    store.recordTurn("sB", "t-sB-1", { toolCallCount: 1, outputText: "c" });

    store.clearSession("sA");

    expect(store.getBlockCount("sA-r1")).toBe(0);
    expect(store.getBlockCount("sA-r2")).toBe(0);
    expect(store.readTurn("t-sA-1")).toBeUndefined();
    expect(store.readTurn("t-sA-2")).toBeUndefined();
    // Other sessions unaffected.
    expect(store.getBlockCount("sB-r1")).toBe(1);
    expect(store.readTurn("t-sB-1")).toEqual({ toolCallCount: 1, outputText: "c" });
  });
});
