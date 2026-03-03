import { describe, expect, it } from "bun:test";
import type { ToolHealthSnapshot } from "@koi/core";
import {
  DEFAULT_CAPABILITY_GAP_PATTERNS,
  detectCapabilityGap,
  detectLatencyDegradation,
  detectRepeatedFailure,
} from "./heuristics.js";

describe("detectRepeatedFailure", () => {
  it("returns undefined when below threshold", () => {
    expect(detectRepeatedFailure("tool-a", 2, 3)).toBeUndefined();
  });

  it("returns trigger when at threshold", () => {
    const trigger = detectRepeatedFailure("tool-a", 3, 3);
    expect(trigger).toBeDefined();
    expect(trigger?.kind).toBe("repeated_failure");
    if (trigger?.kind === "repeated_failure") {
      expect(trigger.toolName).toBe("tool-a");
      expect(trigger.count).toBe(3);
    }
  });

  it("returns trigger when above threshold", () => {
    const trigger = detectRepeatedFailure("tool-b", 5, 3);
    expect(trigger).toBeDefined();
    if (trigger?.kind === "repeated_failure") {
      expect(trigger.count).toBe(5);
    }
  });

  it("returns undefined for zero failures", () => {
    expect(detectRepeatedFailure("tool-a", 0, 3)).toBeUndefined();
  });

  it("returns undefined for threshold of 1 with 0 failures", () => {
    expect(detectRepeatedFailure("tool-a", 0, 1)).toBeUndefined();
  });

  it("returns trigger for threshold of 1 with 1 failure", () => {
    const trigger = detectRepeatedFailure("tool-a", 1, 1);
    expect(trigger).toBeDefined();
    expect(trigger?.kind).toBe("repeated_failure");
  });
});

describe("detectCapabilityGap", () => {
  // True positives — should detect gaps
  const truePositives = [
    "I don't have a tool for that.",
    "I don't have any tool to help with that.",
    "I dont have tool for database queries.",
    "No available tool for file compression.",
    "No suitable tool to parse XML.",
    "No tool that can handle this format.",
    "I'm unable to do this because the tool capability is missing.",
    "I am unable to compress files because no tool capability exists.",
    "I lack the tool to manipulate images.",
    "I lack the capability to generate reports.",
    "I lack the ability to send emails.",
    "There is no tool for video processing.",
    "There are no tools available for PDF parsing.",
    "There is no function for data aggregation.",
    "There are no functions to handle webhooks.",
  ];

  // False positives — should NOT detect gaps
  const falsePositives = [
    "I've used the file tool to read the content.",
    "The tool executed successfully.",
    "No errors found in the output.",
    "I have completed the task using available tools.",
    "The function returned the expected result.",
    "Everything is working as expected.",
  ];

  for (const text of truePositives) {
    it(`detects gap in: "${text}"`, () => {
      const trigger = detectCapabilityGap(text, DEFAULT_CAPABILITY_GAP_PATTERNS, new Map(), 1);
      expect(trigger).toBeDefined();
      expect(trigger?.kind).toBe("capability_gap");
    });
  }

  for (const text of falsePositives) {
    it(`does not detect gap in: "${text}"`, () => {
      const trigger = detectCapabilityGap(text, DEFAULT_CAPABILITY_GAP_PATTERNS, new Map(), 1);
      expect(trigger).toBeUndefined();
    });
  }

  it("respects occurrence threshold", () => {
    const gapCounts = new Map<string, number>();
    // First occurrence — below threshold of 2
    const trigger1 = detectCapabilityGap(
      "I don't have a tool for that.",
      DEFAULT_CAPABILITY_GAP_PATTERNS,
      gapCounts,
      2,
    );
    expect(trigger1).toBeUndefined();

    // Second occurrence — at threshold
    gapCounts.set("I don't have a tool", 1);
    const trigger2 = detectCapabilityGap(
      "I don't have a tool for that.",
      DEFAULT_CAPABILITY_GAP_PATTERNS,
      gapCounts,
      2,
    );
    expect(trigger2).toBeDefined();
  });

  it("returns undefined with empty patterns", () => {
    const trigger = detectCapabilityGap("I don't have a tool for that.", [], new Map(), 1);
    expect(trigger).toBeUndefined();
  });

  it("returns undefined with empty text", () => {
    const trigger = detectCapabilityGap("", DEFAULT_CAPABILITY_GAP_PATTERNS, new Map(), 1);
    expect(trigger).toBeUndefined();
  });
});

describe("detectLatencyDegradation", () => {
  const healthySnapshot: ToolHealthSnapshot = {
    brickId: "brick-1",
    toolId: "tool-a",
    metrics: {
      successRate: 0.9,
      errorRate: 0.1,
      usageCount: 10,
      avgLatencyMs: 200,
    },
    state: "healthy",
    recentFailures: [],
    lastUpdatedAt: 1000,
  };

  const degradedSnapshot: ToolHealthSnapshot = {
    brickId: "brick-2",
    toolId: "tool-b",
    metrics: {
      successRate: 0.5,
      errorRate: 0.5,
      usageCount: 20,
      avgLatencyMs: 6000,
    },
    state: "degraded",
    recentFailures: [],
    lastUpdatedAt: 2000,
  };

  it("returns undefined when snapshot is undefined", () => {
    expect(detectLatencyDegradation("tool-a", undefined, 5000)).toBeUndefined();
  });

  it("returns undefined when usage count is zero", () => {
    const emptySnapshot: ToolHealthSnapshot = {
      ...healthySnapshot,
      metrics: { ...healthySnapshot.metrics, usageCount: 0 },
    };
    expect(detectLatencyDegradation("tool-a", emptySnapshot, 5000)).toBeUndefined();
  });

  it("returns undefined when latency is below threshold", () => {
    expect(detectLatencyDegradation("tool-a", healthySnapshot, 5000)).toBeUndefined();
  });

  it("returns trigger when latency exceeds threshold", () => {
    const trigger = detectLatencyDegradation("tool-b", degradedSnapshot, 5000);
    expect(trigger).toBeDefined();
    expect(trigger?.kind).toBe("performance_degradation");
    if (trigger?.kind === "performance_degradation") {
      expect(trigger.toolName).toBe("tool-b");
      expect(trigger.metric).toContain("avgLatencyMs=6000");
    }
  });

  it("returns undefined when latency equals threshold (boundary)", () => {
    const snapshot: ToolHealthSnapshot = {
      ...healthySnapshot,
      metrics: { ...healthySnapshot.metrics, avgLatencyMs: 5000 },
    };
    expect(detectLatencyDegradation("tool-a", snapshot, 5000)).toBeUndefined();
  });
});
