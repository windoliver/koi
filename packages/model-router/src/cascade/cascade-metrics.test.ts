import { describe, expect, test } from "bun:test";
import type { ModelResponse } from "@koi/core";
import { createCascadeMetricsTracker } from "./cascade-metrics.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(opts?: { inputTokens?: number; outputTokens?: number }): ModelResponse {
  return {
    content: "test",
    model: "test-model",
    ...(opts
      ? { usage: { inputTokens: opts.inputTokens ?? 0, outputTokens: opts.outputTokens ?? 0 } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// createCascadeMetricsTracker
// ---------------------------------------------------------------------------

describe("createCascadeMetricsTracker", () => {
  test("starts with zero metrics", () => {
    const tracker = createCascadeMetricsTracker([{ targetId: "openai:gpt-4o-mini" }]);
    const metrics = tracker.getMetrics();

    expect(metrics.totalRequests).toBe(0);
    expect(metrics.totalEscalations).toBe(0);
    expect(metrics.totalEstimatedCost).toBe(0);
    expect(metrics.tiers).toHaveLength(1);
    expect(metrics.tiers[0]?.requests).toBe(0);
  });

  test("tracks single tier request", () => {
    const tracker = createCascadeMetricsTracker([{ targetId: "openai:gpt-4o-mini" }]);

    tracker.record(
      "openai:gpt-4o-mini",
      makeResponse({ inputTokens: 100, outputTokens: 50 }),
      false,
    );

    const metrics = tracker.getMetrics();
    expect(metrics.totalRequests).toBe(1);
    expect(metrics.totalEscalations).toBe(0);
    expect(metrics.tiers[0]?.requests).toBe(1);
    expect(metrics.tiers[0]?.totalInputTokens).toBe(100);
    expect(metrics.tiers[0]?.totalOutputTokens).toBe(50);
  });

  test("tracks multi-tier with escalation", () => {
    const tracker = createCascadeMetricsTracker([
      { targetId: "openai:gpt-4o-mini" },
      { targetId: "openai:gpt-4o" },
    ]);

    tracker.record(
      "openai:gpt-4o-mini",
      makeResponse({ inputTokens: 100, outputTokens: 50 }),
      true,
    );
    tracker.record("openai:gpt-4o", makeResponse({ inputTokens: 200, outputTokens: 100 }), false);

    const metrics = tracker.getMetrics();
    expect(metrics.totalRequests).toBe(2);
    expect(metrics.totalEscalations).toBe(1);
    expect(metrics.tiers[0]?.escalations).toBe(1);
    expect(metrics.tiers[1]?.escalations).toBe(0);
  });

  test("calculates estimated cost from costPerToken", () => {
    const tracker = createCascadeMetricsTracker([
      { targetId: "openai:gpt-4o-mini", costPerInputToken: 0.001, costPerOutputToken: 0.002 },
    ]);

    tracker.record(
      "openai:gpt-4o-mini",
      makeResponse({ inputTokens: 1000, outputTokens: 500 }),
      false,
    );

    const metrics = tracker.getMetrics();
    // 1000 * 0.001 + 500 * 0.002 = 1.0 + 1.0 = 2.0
    expect(metrics.totalEstimatedCost).toBeCloseTo(2.0, 5);
    expect(metrics.tiers[0]?.estimatedCost).toBeCloseTo(2.0, 5);
  });

  test("missing usage data results in zero cost", () => {
    const tracker = createCascadeMetricsTracker([
      { targetId: "openai:gpt-4o-mini", costPerInputToken: 0.001, costPerOutputToken: 0.002 },
    ]);

    tracker.record("openai:gpt-4o-mini", makeResponse(), false);

    const metrics = tracker.getMetrics();
    expect(metrics.totalEstimatedCost).toBe(0);
  });

  test("snapshot is immutable (returns fresh copy)", () => {
    const tracker = createCascadeMetricsTracker([{ targetId: "openai:gpt-4o-mini" }]);

    const before = tracker.getMetrics();
    tracker.record(
      "openai:gpt-4o-mini",
      makeResponse({ inputTokens: 100, outputTokens: 50 }),
      false,
    );
    const after = tracker.getMetrics();

    expect(before.totalRequests).toBe(0);
    expect(after.totalRequests).toBe(1);
  });

  test("ignores record for unknown tier", () => {
    const tracker = createCascadeMetricsTracker([{ targetId: "openai:gpt-4o-mini" }]);

    tracker.record("unknown:model", makeResponse({ inputTokens: 100, outputTokens: 50 }), false);

    const metrics = tracker.getMetrics();
    expect(metrics.totalRequests).toBe(0);
  });
});
