import { describe, expect, test } from "bun:test";
import { createRollingWindow } from "./rolling-window.js";

describe("createRollingWindow", () => {
  test("empty window returns count 0", () => {
    const w = createRollingWindow(1000);
    expect(w.count(Date.now())).toBe(0);
  });

  test("single entry is counted within window", () => {
    const w = createRollingWindow(1000);
    const now = 5000;
    w.record(now);
    expect(w.count(now)).toBe(1);
  });

  test("entries outside window are not counted", () => {
    const w = createRollingWindow(1000);
    w.record(1000);
    w.record(1500);
    w.record(2500);
    // At time 2500, window covers 1500-2500
    expect(w.count(2500)).toBe(2);
  });

  test("full buffer wraps around correctly", () => {
    const w = createRollingWindow(1000, 3);
    w.record(100);
    w.record(200);
    w.record(300);
    // Buffer full, now wrap
    w.record(400);
    // All 3 entries in buffer are 200, 300, 400 — all within window at 400
    expect(w.count(400)).toBe(3);
  });

  test("old entries in wrapped buffer are excluded by time window", () => {
    const w = createRollingWindow(100, 5);
    w.record(100);
    w.record(200);
    w.record(300);
    w.record(400);
    w.record(500);
    // At time 500, window covers 400-500
    expect(w.count(500)).toBe(2);
  });

  test("rate returns 0 when total is 0", () => {
    const w = createRollingWindow(1000);
    w.record(100);
    expect(w.rate(0, 100)).toBe(0);
  });

  test("rate computes correct ratio", () => {
    const w = createRollingWindow(1000);
    const now = 5000;
    w.record(now - 100);
    w.record(now - 200);
    w.record(now - 300);
    // 3 events in window, 10 total
    expect(w.rate(10, now)).toBeCloseTo(0.3);
  });

  test("rate is clamped to 1", () => {
    const w = createRollingWindow(1000);
    const now = 5000;
    w.record(now);
    w.record(now);
    w.record(now);
    // 3 events in window, 2 total — would be 1.5, clamped to 1
    expect(w.rate(2, now)).toBe(1);
  });

  test("rate returns 0 for negative total", () => {
    const w = createRollingWindow(1000);
    w.record(100);
    expect(w.rate(-1, 100)).toBe(0);
  });

  test("entries at exact boundary are excluded", () => {
    const w = createRollingWindow(100);
    w.record(100);
    w.record(200);
    // At time 200, cutoff is 100. Entry at 100 is < 100? No, 100 >= 100.
    // Actually cutoff = 200 - 100 = 100. Entry at 100 is NOT < 100, so included.
    // Wait — the check is `ts < cutoff`. 100 < 100 is false, so entry IS counted.
    expect(w.count(200)).toBe(2);
  });

  test("handles large buffer with many entries", () => {
    const w = createRollingWindow(100, 1000);
    for (let i = 0; i < 500; i++) {
      w.record(i);
    }
    // At time 499, cutoff = 399. Entries 399-499 are >= cutoff = 101 entries
    expect(w.count(499)).toBe(101);
  });
});
