import { describe, expect, test } from "bun:test";
import { createFrameCounters } from "./frame-counter.js";

describe("createFrameCounters", () => {
  test("increment returns monotonically increasing seq", () => {
    const counters = createFrameCounters();
    expect(counters.increment("a1")).toBe(1);
    expect(counters.increment("a1")).toBe(2);
    expect(counters.increment("a1")).toBe(3);
  });

  test("increment for different agents is independent", () => {
    const counters = createFrameCounters();
    expect(counters.increment("a1")).toBe(1);
    expect(counters.increment("a2")).toBe(1);
    expect(counters.increment("a1")).toBe(2);
    expect(counters.increment("a2")).toBe(2);
  });

  test("updateRemote tracks latest remoteSeq", () => {
    const counters = createFrameCounters();
    counters.updateRemote("a1", 5);
    expect(counters.get("a1").remoteSeq).toBe(5);
    counters.updateRemote("a1", 10);
    expect(counters.get("a1").remoteSeq).toBe(10);
  });

  test("get returns 0/0 for unknown agent", () => {
    const counters = createFrameCounters();
    const state = counters.get("unknown");
    expect(state.seq).toBe(0);
    expect(state.remoteSeq).toBe(0);
  });

  test("get returns current counters", () => {
    const counters = createFrameCounters();
    counters.increment("a1");
    counters.increment("a1");
    counters.updateRemote("a1", 7);

    const state = counters.get("a1");
    expect(state.seq).toBe(2);
    expect(state.remoteSeq).toBe(7);
  });

  test("restore sets both cursors", () => {
    const counters = createFrameCounters();
    counters.restore("a1", 42, 99);

    const state = counters.get("a1");
    expect(state.seq).toBe(42);
    expect(state.remoteSeq).toBe(99);
  });

  test("restore overwrites existing counters", () => {
    const counters = createFrameCounters();
    counters.increment("a1");
    counters.updateRemote("a1", 5);
    counters.restore("a1", 100, 200);

    const state = counters.get("a1");
    expect(state.seq).toBe(100);
    expect(state.remoteSeq).toBe(200);
  });

  test("increment after restore continues from restored value", () => {
    const counters = createFrameCounters();
    counters.restore("a1", 10, 5);
    expect(counters.increment("a1")).toBe(11);
    expect(counters.increment("a1")).toBe(12);
  });

  test("remove clears agent counters", () => {
    const counters = createFrameCounters();
    counters.increment("a1");
    counters.updateRemote("a1", 5);
    counters.remove("a1");

    const state = counters.get("a1");
    expect(state.seq).toBe(0);
    expect(state.remoteSeq).toBe(0);
  });

  test("remove for unknown agent is a no-op", () => {
    const counters = createFrameCounters();
    // Should not throw
    counters.remove("unknown");
    expect(counters.get("unknown").seq).toBe(0);
  });
});
