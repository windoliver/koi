import { describe, expect, it } from "bun:test";
import type { ForgeTrigger } from "@koi/core";
import { computeDemandConfidence, DEFAULT_CONFIDENCE_WEIGHTS } from "./confidence.js";

describe("computeDemandConfidence", () => {
  it("computes confidence for repeated failure trigger", () => {
    const trigger: ForgeTrigger = { kind: "repeated_failure", toolName: "tool-a", count: 3 };
    const score = computeDemandConfidence(trigger, DEFAULT_CONFIDENCE_WEIGHTS, {
      failureCount: 3,
      threshold: 3,
    });
    // baseWeight=0.9, severity=min(3/3,2)=1 → 0.9*1=0.9
    expect(score).toBeCloseTo(0.9, 5);
  });

  it("computes confidence for capability gap trigger", () => {
    const trigger: ForgeTrigger = {
      kind: "capability_gap",
      requiredCapability: "image processing",
    };
    const score = computeDemandConfidence(trigger, DEFAULT_CONFIDENCE_WEIGHTS, {
      failureCount: 2,
      threshold: 2,
    });
    // baseWeight=0.8, severity=1 → 0.8
    expect(score).toBeCloseTo(0.8, 5);
  });

  it("computes confidence for performance degradation trigger", () => {
    const trigger: ForgeTrigger = {
      kind: "performance_degradation",
      toolName: "tool-b",
      metric: "avgLatencyMs=6000",
    };
    const score = computeDemandConfidence(trigger, DEFAULT_CONFIDENCE_WEIGHTS, {
      failureCount: 20,
      threshold: 5000,
    });
    // baseWeight=0.6, severity=min(20/5000,2)=0.004 → 0.6*0.004=0.0024
    expect(score).toBeCloseTo(0.0024, 5);
  });

  it("caps severity multiplier at 2x threshold overshoot", () => {
    const trigger: ForgeTrigger = { kind: "repeated_failure", toolName: "tool-a", count: 100 };
    const score = computeDemandConfidence(trigger, DEFAULT_CONFIDENCE_WEIGHTS, {
      failureCount: 100,
      threshold: 3,
    });
    // baseWeight=0.9, severity=min(100/3,2)=2 → 0.9*2=1.8, clamped to 1.0
    expect(score).toBe(1);
  });

  it("clamps score to maximum of 1.0", () => {
    const trigger: ForgeTrigger = { kind: "repeated_failure", toolName: "tool-a", count: 10 };
    const score = computeDemandConfidence(trigger, DEFAULT_CONFIDENCE_WEIGHTS, {
      failureCount: 10,
      threshold: 3,
    });
    // baseWeight=0.9, severity=min(10/3,2)=2 → 0.9*2=1.8, clamped to 1.0
    expect(score).toBe(1);
  });

  it("handles zero threshold gracefully", () => {
    const trigger: ForgeTrigger = { kind: "repeated_failure", toolName: "tool-a", count: 1 };
    const score = computeDemandConfidence(trigger, DEFAULT_CONFIDENCE_WEIGHTS, {
      failureCount: 1,
      threshold: 0,
    });
    // severity = 1 (fallback for zero threshold)
    expect(score).toBeCloseTo(0.9, 5);
  });

  it("uses custom weights", () => {
    const trigger: ForgeTrigger = { kind: "repeated_failure", toolName: "tool-a", count: 3 };
    const score = computeDemandConfidence(
      trigger,
      { repeatedFailure: 0.5, capabilityGap: 0.5, performanceDegradation: 0.5 },
      { failureCount: 3, threshold: 3 },
    );
    expect(score).toBeCloseTo(0.5, 5);
  });

  it("returns zero when base weight is zero", () => {
    const trigger: ForgeTrigger = { kind: "repeated_failure", toolName: "tool-a", count: 3 };
    const score = computeDemandConfidence(
      trigger,
      { repeatedFailure: 0, capabilityGap: 0.8, performanceDegradation: 0.6 },
      { failureCount: 3, threshold: 3 },
    );
    expect(score).toBe(0);
  });

  it("handles no_matching_tool with capabilityGap weight", () => {
    const trigger: ForgeTrigger = { kind: "no_matching_tool", query: "compress PDF", attempts: 2 };
    const score = computeDemandConfidence(trigger, DEFAULT_CONFIDENCE_WEIGHTS, {
      failureCount: 2,
      threshold: 2,
    });
    // Uses capabilityGap weight (0.8), severity=1 → 0.8
    expect(score).toBeCloseTo(0.8, 5);
  });
});
