import { describe, expect, test } from "bun:test";
import { createBackpressureMonitor } from "../backpressure.js";

const config = {
  maxBufferBytesPerConnection: 1000,
  backpressureHighWatermark: 0.8,
  globalBufferLimitBytes: 5000,
};

describe("createBackpressureMonitor", () => {
  test("starts in normal state", () => {
    const bp = createBackpressureMonitor(config);
    expect(bp.state("c1")).toBe("normal");
    expect(bp.globalUsage()).toBe(0);
    expect(bp.canAccept()).toBe(true);
  });

  test("transitions to warning at 80% threshold", () => {
    const bp = createBackpressureMonitor(config);
    const st = bp.record("c1", 800);
    expect(st).toBe("warning");
  });

  test("transitions to critical at 100%", () => {
    const bp = createBackpressureMonitor(config);
    const st = bp.record("c1", 1000);
    expect(st).toBe("critical");
  });

  test("drain reduces buffered bytes and state", () => {
    const bp = createBackpressureMonitor(config);
    bp.record("c1", 1000); // → critical
    // drain 100 → 900 bytes remaining; warningThreshold=800, 900 >= 800 → warning
    const st = bp.drain("c1", 100);
    expect(st).toBe("warning");
    expect(bp.globalUsage()).toBe(900);
  });

  test("criticalSince is set when entering critical", () => {
    const bp = createBackpressureMonitor(config);
    expect(bp.criticalSince("c1")).toBeUndefined();
    bp.record("c1", 1000);
    expect(bp.criticalSince("c1")).toBeNumber();
  });

  test("criticalSince cleared when leaving critical via drain", () => {
    const bp = createBackpressureMonitor(config);
    bp.record("c1", 1000);
    bp.drain("c1", 500);
    expect(bp.criticalSince("c1")).toBeUndefined();
  });

  test("remove clears connection and reduces global usage", () => {
    const bp = createBackpressureMonitor(config);
    bp.record("c1", 500);
    bp.remove("c1");
    expect(bp.globalUsage()).toBe(0);
    expect(bp.state("c1")).toBe("normal");
  });

  test("canAccept returns false when global limit exceeded", () => {
    const bp = createBackpressureMonitor(config);
    bp.record("c1", 2500);
    bp.record("c2", 2500);
    expect(bp.globalUsage()).toBe(5000);
    expect(bp.canAccept()).toBe(false);
  });

  test("multiple connections tracked independently", () => {
    const bp = createBackpressureMonitor(config);
    bp.record("c1", 900);
    bp.record("c2", 100);
    expect(bp.state("c1")).toBe("warning");
    expect(bp.state("c2")).toBe("normal");
  });

  test("drain on unknown connection returns normal", () => {
    const bp = createBackpressureMonitor(config);
    expect(bp.drain("unknown", 100)).toBe("normal");
  });
});
