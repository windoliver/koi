import { describe, expect, it } from "bun:test";
import type { ForgeTrigger } from "@koi/core";
import { computeDemandConfidence, DEFAULT_CONFIDENCE_WEIGHTS } from "./confidence.js";

describe("computeDemandConfidence", () => {
  it("scores repeated_failure deterministically", () => {
    const trigger: ForgeTrigger = { kind: "repeated_failure", toolName: "t", count: 3 };
    const a = computeDemandConfidence(trigger, DEFAULT_CONFIDENCE_WEIGHTS, {
      failureCount: 3,
      threshold: 3,
    });
    const b = computeDemandConfidence(trigger, DEFAULT_CONFIDENCE_WEIGHTS, {
      failureCount: 3,
      threshold: 3,
    });
    expect(a).toBeCloseTo(0.9);
    expect(a).toBe(b);
  });

  it("clamps to [0, 1] even at high overshoot", () => {
    const trigger: ForgeTrigger = { kind: "repeated_failure", toolName: "t", count: 100 };
    const score = computeDemandConfidence(trigger, DEFAULT_CONFIDENCE_WEIGHTS, {
      failureCount: 100,
      threshold: 3,
    });
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThan(0);
  });

  it("returns base weight when threshold equals failureCount", () => {
    const trigger: ForgeTrigger = { kind: "capability_gap", requiredCapability: "x" };
    const score = computeDemandConfidence(trigger, DEFAULT_CONFIDENCE_WEIGHTS, {
      failureCount: 2,
      threshold: 2,
    });
    expect(score).toBeCloseTo(DEFAULT_CONFIDENCE_WEIGHTS.capabilityGap);
  });

  it("orders trigger kinds by base weight (repeated > capability > performance)", () => {
    const ctx = { failureCount: 1, threshold: 1 } as const;
    const rf = computeDemandConfidence(
      { kind: "repeated_failure", toolName: "t", count: 1 },
      DEFAULT_CONFIDENCE_WEIGHTS,
      ctx,
    );
    const cg = computeDemandConfidence(
      { kind: "capability_gap", requiredCapability: "x" },
      DEFAULT_CONFIDENCE_WEIGHTS,
      ctx,
    );
    const pd = computeDemandConfidence(
      { kind: "performance_degradation", toolName: "t", metric: "x" },
      DEFAULT_CONFIDENCE_WEIGHTS,
      ctx,
    );
    expect(rf).toBeGreaterThan(cg);
    expect(cg).toBeGreaterThan(pd);
  });
});
