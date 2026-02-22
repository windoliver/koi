import { describe, expect, test } from "bun:test";
import { createBackpressureMonitor } from "../backpressure.js";

const DEFAULT_CONFIG = {
  maxBufferBytesPerConnection: 100,
  backpressureHighWatermark: 0.8,
  globalBufferLimitBytes: 10_000,
} as const;

describe("BackpressureMonitor", () => {
  test("starts in normal state", () => {
    const bp = createBackpressureMonitor(DEFAULT_CONFIG);
    expect(bp.state("conn-1")).toBe("normal");
  });

  test("transitions to warning at 80% watermark", () => {
    const bp = createBackpressureMonitor(DEFAULT_CONFIG);
    // 80 out of 100 = exactly at watermark
    const state = bp.record("conn-1", 80);
    expect(state).toBe("warning");
  });

  test("stays normal just below watermark", () => {
    const bp = createBackpressureMonitor(DEFAULT_CONFIG);
    const state = bp.record("conn-1", 79);
    expect(state).toBe("normal");
  });

  test("transitions to critical at 100%", () => {
    const bp = createBackpressureMonitor(DEFAULT_CONFIG);
    const state = bp.record("conn-1", 100);
    expect(state).toBe("critical");
  });

  test("warning at exactly watermark boundary", () => {
    const bp = createBackpressureMonitor(DEFAULT_CONFIG);
    // floor(100 * 0.8) = 80
    bp.record("conn-1", 79);
    expect(bp.state("conn-1")).toBe("normal");
    bp.record("conn-1", 1);
    expect(bp.state("conn-1")).toBe("warning");
  });

  test("drain returns to normal", () => {
    const bp = createBackpressureMonitor(DEFAULT_CONFIG);
    bp.record("conn-1", 90); // warning
    expect(bp.state("conn-1")).toBe("warning");
    bp.drain("conn-1", 50);
    expect(bp.state("conn-1")).toBe("normal");
  });

  test("drain from critical through warning to normal", () => {
    const bp = createBackpressureMonitor(DEFAULT_CONFIG);
    bp.record("conn-1", 100);
    expect(bp.state("conn-1")).toBe("critical");

    bp.drain("conn-1", 10);
    expect(bp.state("conn-1")).toBe("warning");

    bp.drain("conn-1", 20);
    expect(bp.state("conn-1")).toBe("normal");
  });

  test("drain never goes below zero", () => {
    const bp = createBackpressureMonitor(DEFAULT_CONFIG);
    bp.record("conn-1", 10);
    bp.drain("conn-1", 100); // drain more than buffered
    expect(bp.state("conn-1")).toBe("normal");
    expect(bp.globalUsage()).toBe(0);
  });

  test("drain on unknown connection is safe", () => {
    const bp = createBackpressureMonitor(DEFAULT_CONFIG);
    expect(bp.drain("unknown", 50)).toBe("normal");
  });

  test("tracks global buffer usage", () => {
    const bp = createBackpressureMonitor(DEFAULT_CONFIG);
    bp.record("conn-1", 30);
    bp.record("conn-2", 50);
    expect(bp.globalUsage()).toBe(80);
  });

  test("global limit enforcement", () => {
    const bp = createBackpressureMonitor({
      ...DEFAULT_CONFIG,
      globalBufferLimitBytes: 100,
    });
    bp.record("conn-1", 60);
    bp.record("conn-2", 50);
    expect(bp.canAccept()).toBe(false);
  });

  test("canAccept returns true when under global limit", () => {
    const bp = createBackpressureMonitor(DEFAULT_CONFIG);
    bp.record("conn-1", 50);
    expect(bp.canAccept()).toBe(true);
  });

  test("remove clears connection and adjusts global", () => {
    const bp = createBackpressureMonitor(DEFAULT_CONFIG);
    bp.record("conn-1", 50);
    bp.record("conn-2", 30);
    expect(bp.globalUsage()).toBe(80);

    bp.remove("conn-1");
    expect(bp.globalUsage()).toBe(30);
    expect(bp.state("conn-1")).toBe("normal"); // unknown conn → normal
  });

  test("criticalSince tracks when critical state started", () => {
    const bp = createBackpressureMonitor(DEFAULT_CONFIG);
    expect(bp.criticalSince("conn-1")).toBeUndefined();

    bp.record("conn-1", 100);
    const since = bp.criticalSince("conn-1");
    expect(since).toBeDefined();
    expect(typeof since).toBe("number");
  });

  test("criticalSince resets when leaving critical", () => {
    const bp = createBackpressureMonitor(DEFAULT_CONFIG);
    bp.record("conn-1", 100);
    expect(bp.criticalSince("conn-1")).toBeDefined();

    bp.drain("conn-1", 10);
    expect(bp.criticalSince("conn-1")).toBeUndefined();
  });

  test("simultaneous drain and record", () => {
    const bp = createBackpressureMonitor(DEFAULT_CONFIG);
    bp.record("conn-1", 90);
    // Drain and record happen — net effect matters
    bp.drain("conn-1", 50);
    bp.record("conn-1", 20);
    // 90 - 50 + 20 = 60
    expect(bp.state("conn-1")).toBe("normal");
  });

  test("independent connections have independent states", () => {
    const bp = createBackpressureMonitor(DEFAULT_CONFIG);
    bp.record("conn-1", 90);
    bp.record("conn-2", 10);
    expect(bp.state("conn-1")).toBe("warning");
    expect(bp.state("conn-2")).toBe("normal");
  });
});
