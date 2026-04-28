import { describe, expect, it } from "bun:test";
import type { ToolHealthSnapshot } from "@koi/core";
import {
  DEFAULT_CAPABILITY_GAP_PATTERNS,
  DEFAULT_USER_CORRECTION_PATTERNS,
  detectCapabilityGap,
  detectLatencyDegradation,
  detectRepeatedFailure,
  detectUserCorrection,
} from "./heuristics.js";

describe("detectRepeatedFailure", () => {
  it("returns trigger when consecutive failures meet threshold", () => {
    const trigger = detectRepeatedFailure("tool-a", 3, 3);
    expect(trigger).toBeDefined();
    expect(trigger?.kind).toBe("repeated_failure");
    if (trigger?.kind === "repeated_failure") {
      expect(trigger.toolName).toBe("tool-a");
      expect(trigger.count).toBe(3);
    }
  });

  it("returns undefined below threshold", () => {
    expect(detectRepeatedFailure("tool-a", 2, 3)).toBeUndefined();
  });
});

describe("detectCapabilityGap", () => {
  it("returns trigger only when gap count meets threshold", () => {
    const text = "I don't have a tool for that";
    const counts = new Map<string, number>();
    // First call — count is 0; should not trigger.
    expect(detectCapabilityGap(text, DEFAULT_CAPABILITY_GAP_PATTERNS, counts, 2)).toBeUndefined();

    // Simulate threshold reached.
    const matched = DEFAULT_CAPABILITY_GAP_PATTERNS.find((p) => p.test(text));
    expect(matched).toBeDefined();
    if (matched !== undefined) {
      counts.set(matched.source, 2);
    }
    const trigger = detectCapabilityGap(text, DEFAULT_CAPABILITY_GAP_PATTERNS, counts, 2);
    expect(trigger?.kind).toBe("capability_gap");
  });

  it("returns undefined for unrelated text", () => {
    expect(
      detectCapabilityGap("everything is fine", DEFAULT_CAPABILITY_GAP_PATTERNS, new Map(), 1),
    ).toBeUndefined();
  });
});

describe("detectLatencyDegradation", () => {
  function snapshot(avg: number, usage: number): ToolHealthSnapshot {
    return {
      brickId: "brick-1",
      toolId: "tool-a",
      metrics: { successRate: 1, errorRate: 0, usageCount: usage, avgLatencyMs: avg },
      state: "healthy",
      recentFailures: [],
      lastUpdatedAt: 0,
    };
  }

  it("returns trigger when avg latency exceeds threshold", () => {
    const trigger = detectLatencyDegradation("tool-a", snapshot(6_000, 5), 5_000);
    expect(trigger?.kind).toBe("performance_degradation");
  });

  it("returns undefined when usage is zero", () => {
    expect(detectLatencyDegradation("tool-a", snapshot(9_999, 0), 5_000)).toBeUndefined();
  });

  it("returns undefined when snapshot is missing", () => {
    expect(detectLatencyDegradation("tool-a", undefined, 5_000)).toBeUndefined();
  });
});

describe("detectUserCorrection", () => {
  it("detects 'no, that's not right'", () => {
    const trigger = detectUserCorrection(
      "No, that's not right — try the other tool",
      DEFAULT_USER_CORRECTION_PATTERNS,
      "tool-a",
    );
    expect(trigger?.kind).toBe("user_correction");
    if (trigger?.kind === "user_correction") {
      expect(trigger.correctedToolCall).toBe("tool-a");
    }
  });

  it("returns undefined for non-correction text", () => {
    expect(
      detectUserCorrection("thanks!", DEFAULT_USER_CORRECTION_PATTERNS, "tool-a"),
    ).toBeUndefined();
  });
});
