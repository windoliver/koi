import { describe, expect, test } from "bun:test";
import { createStateStore } from "./state.js";

describe("createStateStore", () => {
  test("recordTurn / readTurn round-trips", () => {
    const store = createStateStore();
    store.recordTurn("t1", { toolCallCount: 2, outputText: "hi" });
    expect(store.readTurn("t1")).toEqual({ toolCallCount: 2, outputText: "hi" });
  });

  test("readTurn returns undefined for missing id", () => {
    const store = createStateStore();
    expect(store.readTurn("missing")).toBeUndefined();
  });

  test("clearTurn removes entry", () => {
    const store = createStateStore();
    store.recordTurn("t1", { toolCallCount: 0, outputText: "" });
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

  test("clearSession drops block counter but NOT turn states", () => {
    // turn states are keyed by turnId not sessionId, so clearSession drops only block counter
    const store = createStateStore();
    store.incrementBlocks("s1");
    store.recordTurn("t1", { toolCallCount: 1, outputText: "" });
    store.clearSession("s1");
    expect(store.getBlockCount("s1")).toBe(0);
    expect(store.readTurn("t1")).toEqual({ toolCallCount: 1, outputText: "" });
  });
});
