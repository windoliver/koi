import { describe, expect, test } from "bun:test";
import { createMetricsAccumulator } from "./metrics.js";

describe("createMetricsAccumulator", () => {
  test("starts with zero values", () => {
    const acc = createMetricsAccumulator();
    const snap = acc.snapshot();
    expect(snap.inputTokens).toBe(0);
    expect(snap.outputTokens).toBe(0);
    expect(snap.totalTokens).toBe(0);
    expect(snap.turns).toBe(0);
    expect(snap.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("accumulates usage across multiple calls", () => {
    const acc = createMetricsAccumulator();
    acc.addUsage(100, 50);
    acc.addUsage(200, 75);

    const snap = acc.snapshot();
    expect(snap.inputTokens).toBe(300);
    expect(snap.outputTokens).toBe(125);
    expect(snap.totalTokens).toBe(425);
  });

  test("tracks turns independently", () => {
    const acc = createMetricsAccumulator();
    acc.addTurn();
    acc.addTurn();
    acc.addTurn();

    expect(acc.snapshot().turns).toBe(3);
  });

  test("finalize returns immutable EngineMetrics", () => {
    const acc = createMetricsAccumulator();
    acc.addUsage(10, 20);
    acc.addTurn();

    const metrics = acc.finalize();
    expect(metrics.inputTokens).toBe(10);
    expect(metrics.outputTokens).toBe(20);
    expect(metrics.totalTokens).toBe(30);
    expect(metrics.turns).toBe(1);
    expect(metrics.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("durationMs increases over time", async () => {
    const acc = createMetricsAccumulator();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const metrics = acc.finalize();
    expect(metrics.durationMs).toBeGreaterThanOrEqual(5);
  });

  test("snapshot does not interfere with subsequent accumulation", () => {
    const acc = createMetricsAccumulator();
    acc.addUsage(10, 5);
    acc.snapshot();
    acc.addUsage(20, 10);

    const metrics = acc.finalize();
    expect(metrics.inputTokens).toBe(30);
    expect(metrics.outputTokens).toBe(15);
  });
});
