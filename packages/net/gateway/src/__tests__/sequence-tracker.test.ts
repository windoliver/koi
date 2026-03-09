import { beforeEach, describe, expect, test } from "bun:test";
import { createSequenceTracker } from "../sequence-tracker.js";
import { createTestFrame, resetTestSeqCounter } from "./test-utils.js";

beforeEach(() => {
  resetTestSeqCounter();
});

describe("ordering", () => {
  test("accepts in-order frames", () => {
    const tracker = createSequenceTracker(128);
    const f0 = createTestFrame({ seq: 0 });
    const f1 = createTestFrame({ seq: 1 });
    const f2 = createTestFrame({ seq: 2 });

    const r0 = tracker.accept(f0);
    expect(r0.result).toBe("accepted");
    expect(r0.ready).toEqual([f0]);

    const r1 = tracker.accept(f1);
    expect(r1.result).toBe("accepted");
    expect(r1.ready).toEqual([f1]);

    const r2 = tracker.accept(f2);
    expect(r2.result).toBe("accepted");
    expect(r2.ready).toEqual([f2]);

    expect(tracker.expectedSeq()).toBe(3);
  });

  test("buffers out-of-order frames", () => {
    const tracker = createSequenceTracker(128);
    const f1 = createTestFrame({ seq: 1 });

    const r = tracker.accept(f1);
    expect(r.result).toBe("buffered");
    expect(r.ready).toEqual([]);
    expect(tracker.bufferedCount()).toBe(1);
  });

  test("delivers buffered frames when gap fills", () => {
    const tracker = createSequenceTracker(128);
    const f0 = createTestFrame({ seq: 0 });
    const f1 = createTestFrame({ seq: 1 });
    const f2 = createTestFrame({ seq: 2 });

    // Receive out of order: 2, 1, 0
    tracker.accept(f2);
    tracker.accept(f1);

    expect(tracker.bufferedCount()).toBe(2);

    const r = tracker.accept(f0);
    expect(r.result).toBe("accepted");
    // Should deliver f0, f1, f2 in order
    expect(r.ready).toEqual([f0, f1, f2]);
    expect(tracker.bufferedCount()).toBe(0);
    expect(tracker.expectedSeq()).toBe(3);
  });

  test("rejects frame beyond max window gap", () => {
    const tracker = createSequenceTracker(4);
    const farFrame = createTestFrame({ seq: 4 });

    const r = tracker.accept(farFrame);
    expect(r.result).toBe("out_of_window");
    expect(r.ready).toEqual([]);
  });

  test("accepts frame at window boundary", () => {
    const tracker = createSequenceTracker(4);
    const f3 = createTestFrame({ seq: 3 });

    const r = tracker.accept(f3);
    expect(r.result).toBe("buffered");
  });

  test("window advances as frames are accepted", () => {
    const tracker = createSequenceTracker(4);
    // Accept 0, 1, 2, 3
    for (let i = 0; i < 4; i++) {
      tracker.accept(createTestFrame({ seq: i }));
    }
    // Now expectedSeq is 4, window allows up to seq 7
    const f7 = createTestFrame({ seq: 7 });
    const r = tracker.accept(f7);
    expect(r.result).toBe("buffered");
  });
});

describe("dedup", () => {
  test("drops duplicate within window", () => {
    const tracker = createSequenceTracker(128);
    const f0 = createTestFrame({ seq: 0, id: "same-id" });

    tracker.accept(f0);

    const dup = createTestFrame({ seq: 0, id: "same-id" });
    const r = tracker.accept(dup);
    expect(r.result).toBe("duplicate");
    expect(r.ready).toEqual([]);
  });

  test("rejects duplicate by ID even with different seq", () => {
    const tracker = createSequenceTracker(128);
    const f0 = createTestFrame({ seq: 0, id: "shared-id" });
    tracker.accept(f0);

    // Same ID but seq=1 — should be caught by ID dedup
    const f1 = createTestFrame({ seq: 1, id: "shared-id" });
    const r = tracker.accept(f1);
    expect(r.result).toBe("duplicate");
  });

  test("detects duplicate for already-processed seq", () => {
    const tracker = createSequenceTracker(128);
    tracker.accept(createTestFrame({ seq: 0 }));
    tracker.accept(createTestFrame({ seq: 1 }));

    // Re-send seq 0 with a new ID
    const dup = createTestFrame({ seq: 0, id: "new-id-for-old-seq" });
    const r = tracker.accept(dup);
    expect(r.result).toBe("duplicate");
  });

  test("allows same seq after reset", () => {
    const tracker = createSequenceTracker(128);
    const f0 = createTestFrame({ seq: 0, id: "id-a" });
    tracker.accept(f0);

    tracker.reset(0);

    const f0b = createTestFrame({ seq: 0, id: "id-b" });
    const r = tracker.accept(f0b);
    expect(r.result).toBe("accepted");
  });
});

describe("combined", () => {
  test("reorders then delivers without duplicates", () => {
    const tracker = createSequenceTracker(128);
    const f0 = createTestFrame({ seq: 0, id: "a" });
    const f1 = createTestFrame({ seq: 1, id: "b" });
    const f2 = createTestFrame({ seq: 2, id: "c" });

    tracker.accept(f2); // buffered
    tracker.accept(f1); // buffered

    // Try duplicate of f2
    const dup = createTestFrame({ seq: 2, id: "c" });
    expect(tracker.accept(dup).result).toBe("duplicate");

    // Fill gap → delivers f0, f1, f2
    const r = tracker.accept(f0);
    expect(r.result).toBe("accepted");
    expect(r.ready).toHaveLength(3);
    expect(r.ready[0]?.seq).toBe(0);
    expect(r.ready[1]?.seq).toBe(1);
    expect(r.ready[2]?.seq).toBe(2);
  });

  test("reconnection with seq gap uses reset", () => {
    const tracker = createSequenceTracker(128);
    // Client had sent 0, 1, 2
    tracker.accept(createTestFrame({ seq: 0 }));
    tracker.accept(createTestFrame({ seq: 1 }));
    tracker.accept(createTestFrame({ seq: 2 }));

    // Reconnect — server resets tracker to client's last known seq
    tracker.reset(3);

    const f3 = createTestFrame({ seq: 3 });
    const r = tracker.accept(f3);
    expect(r.result).toBe("accepted");
    expect(tracker.expectedSeq()).toBe(4);
  });

  test("rejects second frame with same seq but different id (regression)", () => {
    const tracker = createSequenceTracker(128);

    // Buffer seq 5 with id "a"
    const fa = createTestFrame({ seq: 5, id: "a" });
    const ra = tracker.accept(fa);
    expect(ra.result).toBe("buffered");

    // Second frame with same seq but different id should be rejected
    const fb = createTestFrame({ seq: 5, id: "b" });
    const rb = tracker.accept(fb);
    expect(rb.result).toBe("duplicate");
    expect(tracker.bufferedCount()).toBe(1);
  });
});
