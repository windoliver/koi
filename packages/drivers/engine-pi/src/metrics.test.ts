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

  test("addUsage accumulates cache tokens", () => {
    const acc = createMetricsAccumulator();
    acc.addUsage(100, 50, 20, 10);

    const snap = acc.snapshot();
    expect(snap.cacheReadTokens).toBe(20);
    expect(snap.cacheCreationTokens).toBe(10);
  });

  test("addUsage treats missing cache params as zero", () => {
    const acc = createMetricsAccumulator();
    acc.addUsage(100, 50);
    acc.addUsage(200, 75, 30, 15);

    const snap = acc.snapshot();
    expect(snap.cacheReadTokens).toBe(30);
    expect(snap.cacheCreationTokens).toBe(15);
  });

  test("finalizeWithMetadata includes cacheReadTokens when non-zero", () => {
    const acc = createMetricsAccumulator();
    acc.addUsage(100, 50, 42, 0);

    const { metadata } = acc.finalizeWithMetadata();
    expect(metadata.cacheReadTokens).toBe(42);
    expect(metadata.cacheCreationTokens).toBeUndefined();
  });

  test("finalizeWithMetadata omits cache fields when zero", () => {
    const acc = createMetricsAccumulator();
    acc.addUsage(100, 50);

    const { metadata } = acc.finalizeWithMetadata();
    expect(metadata.cacheReadTokens).toBeUndefined();
    expect(metadata.cacheCreationTokens).toBeUndefined();
  });

  test("addCost accumulates cost across turns", () => {
    const acc = createMetricsAccumulator();
    acc.addCost({ input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.005, total: 0.036 });
    acc.addCost({ input: 0.02, output: 0.03, cacheRead: 0.002, cacheWrite: 0.01, total: 0.062 });

    const { metrics, metadata } = acc.finalizeWithMetadata();
    expect(metrics.costUsd).toBeCloseTo(0.098);
    expect(metadata.totalCostUsd).toBeCloseTo(0.098);
    const breakdown = metadata.costBreakdown as { input: number; output: number };
    expect(breakdown.input).toBeCloseTo(0.03);
    expect(breakdown.output).toBeCloseTo(0.05);
  });

  test("finalize includes costUsd when cost has been accumulated", () => {
    const acc = createMetricsAccumulator();
    acc.addCost({ input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 });

    const metrics = acc.finalize();
    expect(metrics.costUsd).toBeCloseTo(0.03);
  });

  test("finalize omits costUsd when no cost accumulated", () => {
    const acc = createMetricsAccumulator();
    acc.addUsage(100, 50);

    const metrics = acc.finalize();
    expect(metrics.costUsd).toBeUndefined();
  });

  test("snapshot includes cache tokens in initial state", () => {
    const acc = createMetricsAccumulator();
    const snap = acc.snapshot();
    expect(snap.cacheReadTokens).toBe(0);
    expect(snap.cacheCreationTokens).toBe(0);
  });
});
