import { describe, expect, test } from "bun:test";
import { createSequenceTracker } from "../sequence-tracker.js";
import type { GatewayFrame } from "../types.js";

function makeFrame(seq: number, id = `f-${seq}`): GatewayFrame {
  return { kind: "request", id, seq, timestamp: Date.now(), payload: null };
}

describe("createSequenceTracker", () => {
  test("accepts in-order frames immediately", () => {
    const tracker = createSequenceTracker(16);
    const r = tracker.accept(makeFrame(0));
    expect(r.result).toBe("accepted");
    expect(r.ready).toHaveLength(1);
    expect(tracker.expectedSeq()).toBe(1);
  });

  test("buffers out-of-order frames", () => {
    const tracker = createSequenceTracker(16);
    const r = tracker.accept(makeFrame(1));
    expect(r.result).toBe("buffered");
    expect(r.ready).toHaveLength(0);
    expect(tracker.bufferedCount()).toBe(1);
  });

  test("flushes buffered frames when gap fills", () => {
    const tracker = createSequenceTracker(16);
    tracker.accept(makeFrame(1));
    tracker.accept(makeFrame(2));
    const r = tracker.accept(makeFrame(0));
    expect(r.result).toBe("accepted");
    expect(r.ready).toHaveLength(3); // 0, 1, 2
    expect(r.ready.map((f) => f.seq)).toEqual([0, 1, 2]);
    expect(tracker.bufferedCount()).toBe(0);
  });

  test("rejects duplicate by seq (already processed)", () => {
    const tracker = createSequenceTracker(16);
    tracker.accept(makeFrame(0));
    const r = tracker.accept(makeFrame(0, "other-id"));
    expect(r.result).toBe("duplicate");
  });

  test("rejects duplicate by frame ID within window", () => {
    const tracker = createSequenceTracker(16);
    tracker.accept(makeFrame(0, "dup-id"));
    const r = tracker.accept({ ...makeFrame(1), id: "dup-id" });
    expect(r.result).toBe("duplicate");
  });

  test("rejects frames beyond window", () => {
    const tracker = createSequenceTracker(8);
    const r = tracker.accept(makeFrame(8)); // nextExpected=0, window=8, so seq=8 is out
    expect(r.result).toBe("out_of_window");
  });

  test("reset clears state and restarts from startSeq", () => {
    const tracker = createSequenceTracker(16);
    tracker.accept(makeFrame(0));
    tracker.accept(makeFrame(1));
    tracker.reset(5);
    expect(tracker.expectedSeq()).toBe(5);
    expect(tracker.bufferedCount()).toBe(0);
    const r = tracker.accept(makeFrame(5));
    expect(r.result).toBe("accepted");
  });

  test("default reset starts from 0", () => {
    const tracker = createSequenceTracker(16);
    tracker.accept(makeFrame(0));
    tracker.reset();
    expect(tracker.expectedSeq()).toBe(0);
  });
});
