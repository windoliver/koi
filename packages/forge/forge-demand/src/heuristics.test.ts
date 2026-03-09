import { describe, expect, it } from "bun:test";
import type { BrickId, KoiError, Result, TaskableAgent, ToolHealthSnapshot } from "@koi/core";
import {
  DEFAULT_CAPABILITY_GAP_PATTERNS,
  DEFAULT_USER_CORRECTION_PATTERNS,
  detectAgentCapabilityGap,
  detectAgentLatencyDegradation,
  detectAgentRepeatedFailure,
  detectCapabilityGap,
  detectComplexTaskCompletion,
  detectLatencyDegradation,
  detectNovelWorkflow,
  detectRepeatedFailure,
  detectUserCorrection,
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
      // Count must be >= threshold. In real usage, updateGapCounts increments
      // before detectCapabilityGap reads. Simulate with threshold=0 to test
      // regex matching independently of counting logic.
      const trigger = detectCapabilityGap(text, DEFAULT_CAPABILITY_GAP_PATTERNS, new Map(), 0);
      expect(trigger).toBeDefined();
      expect(trigger?.kind).toBe("capability_gap");
    });
  }

  for (const text of falsePositives) {
    it(`does not detect gap in: "${text}"`, () => {
      const trigger = detectCapabilityGap(text, DEFAULT_CAPABILITY_GAP_PATTERNS, new Map(), 0);
      expect(trigger).toBeUndefined();
    });
  }

  it("respects occurrence threshold", () => {
    const gapCounts = new Map<string, number>();
    // Count 0 (empty map) — below threshold of 2
    const trigger1 = detectCapabilityGap(
      "I don't have a tool for that.",
      DEFAULT_CAPABILITY_GAP_PATTERNS,
      gapCounts,
      2,
    );
    expect(trigger1).toBeUndefined();

    // Count 2 — at threshold (caller incremented via updateGapCounts)
    gapCounts.set("I don't have a tool", 2);
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

// ---------------------------------------------------------------------------
// Agent-level heuristics
// ---------------------------------------------------------------------------

describe("detectAgentCapabilityGap", () => {
  const MOCK_AGENT: TaskableAgent = {
    name: "test-agent",
    description: "Test",
    manifest: { name: "test", version: "0.0.1", model: { name: "mock" } },
  };

  it("returns trigger when resolve returns NOT_FOUND", () => {
    const result: Result<TaskableAgent, KoiError> = {
      ok: false,
      error: { code: "NOT_FOUND", message: "no agent", retryable: false },
    };
    const trigger = detectAgentCapabilityGap("research", result);
    expect(trigger).toBeDefined();
    expect(trigger?.kind).toBe("agent_capability_gap");
    if (trigger?.kind === "agent_capability_gap") {
      expect(trigger.agentType).toBe("research");
    }
  });

  it("returns undefined when resolve succeeds", () => {
    const result: Result<TaskableAgent, KoiError> = { ok: true, value: MOCK_AGENT };
    expect(detectAgentCapabilityGap("research", result)).toBeUndefined();
  });

  it("returns undefined for non-NOT_FOUND errors", () => {
    const result: Result<TaskableAgent, KoiError> = {
      ok: false,
      error: { code: "EXTERNAL", message: "store down", retryable: true },
    };
    expect(detectAgentCapabilityGap("research", result)).toBeUndefined();
  });
});

describe("detectAgentRepeatedFailure", () => {
  const BRICK_ID = "sha256:abc123" as BrickId;

  const healthySnapshot: ToolHealthSnapshot = {
    brickId: BRICK_ID,
    toolId: "agent:research",
    metrics: { successRate: 0.9, errorRate: 0.1, usageCount: 20, avgLatencyMs: 200 },
    state: "healthy",
    recentFailures: [],
    lastUpdatedAt: 1000,
  };

  const failingSnapshot: ToolHealthSnapshot = {
    brickId: BRICK_ID,
    toolId: "agent:research",
    metrics: { successRate: 0.3, errorRate: 0.7, usageCount: 10, avgLatencyMs: 500 },
    state: "degraded",
    recentFailures: [],
    lastUpdatedAt: 2000,
  };

  it("returns undefined when snapshot is undefined", () => {
    expect(detectAgentRepeatedFailure("research", BRICK_ID, undefined, 0.5)).toBeUndefined();
  });

  it("returns undefined when usage count below minSamples", () => {
    const lowUsage: ToolHealthSnapshot = {
      ...failingSnapshot,
      metrics: { ...failingSnapshot.metrics, usageCount: 3 },
    };
    expect(detectAgentRepeatedFailure("research", BRICK_ID, lowUsage, 0.5)).toBeUndefined();
  });

  it("returns undefined when error rate below threshold", () => {
    expect(detectAgentRepeatedFailure("research", BRICK_ID, healthySnapshot, 0.5)).toBeUndefined();
  });

  it("returns trigger when error rate exceeds threshold", () => {
    const trigger = detectAgentRepeatedFailure("research", BRICK_ID, failingSnapshot, 0.5);
    expect(trigger).toBeDefined();
    expect(trigger?.kind).toBe("agent_repeated_failure");
    if (trigger?.kind === "agent_repeated_failure") {
      expect(trigger.agentType).toBe("research");
      expect(trigger.brickId).toBe(BRICK_ID);
      expect(trigger.errorRate).toBe(0.7);
    }
  });

  it("respects custom minSamples parameter", () => {
    const trigger = detectAgentRepeatedFailure("research", BRICK_ID, failingSnapshot, 0.5, 15);
    expect(trigger).toBeUndefined(); // usageCount=10 < minSamples=15
  });

  it("returns trigger at threshold boundary (error rate equals threshold)", () => {
    const atThreshold: ToolHealthSnapshot = {
      ...healthySnapshot,
      metrics: { ...healthySnapshot.metrics, errorRate: 0.5 },
    };
    const trigger = detectAgentRepeatedFailure("research", BRICK_ID, atThreshold, 0.5);
    expect(trigger).toBeDefined();
    expect(trigger?.kind).toBe("agent_repeated_failure");
  });

  it("returns undefined just below threshold", () => {
    const belowThreshold: ToolHealthSnapshot = {
      ...healthySnapshot,
      metrics: { ...healthySnapshot.metrics, errorRate: 0.49 },
    };
    expect(detectAgentRepeatedFailure("research", BRICK_ID, belowThreshold, 0.5)).toBeUndefined();
  });
});

describe("detectAgentLatencyDegradation", () => {
  const BRICK_ID = "sha256:def456" as BrickId;

  const fastSnapshot: ToolHealthSnapshot = {
    brickId: BRICK_ID,
    toolId: "agent:code",
    metrics: { successRate: 0.95, errorRate: 0.05, usageCount: 30, avgLatencyMs: 500 },
    state: "healthy",
    recentFailures: [],
    lastUpdatedAt: 1000,
  };

  const slowSnapshot: ToolHealthSnapshot = {
    brickId: BRICK_ID,
    toolId: "agent:code",
    metrics: { successRate: 0.8, errorRate: 0.2, usageCount: 15, avgLatencyMs: 12000 },
    state: "degraded",
    recentFailures: [],
    lastUpdatedAt: 2000,
  };

  it("returns undefined when snapshot is undefined", () => {
    expect(detectAgentLatencyDegradation("code", BRICK_ID, undefined, 10000)).toBeUndefined();
  });

  it("returns undefined when usage count is zero", () => {
    const emptySnapshot: ToolHealthSnapshot = {
      ...fastSnapshot,
      metrics: { ...fastSnapshot.metrics, usageCount: 0 },
    };
    expect(detectAgentLatencyDegradation("code", BRICK_ID, emptySnapshot, 10000)).toBeUndefined();
  });

  it("returns undefined when latency below threshold", () => {
    expect(detectAgentLatencyDegradation("code", BRICK_ID, fastSnapshot, 10000)).toBeUndefined();
  });

  it("returns trigger when latency exceeds threshold", () => {
    const trigger = detectAgentLatencyDegradation("code", BRICK_ID, slowSnapshot, 10000);
    expect(trigger).toBeDefined();
    expect(trigger?.kind).toBe("agent_latency_degradation");
    if (trigger?.kind === "agent_latency_degradation") {
      expect(trigger.agentType).toBe("code");
      expect(trigger.brickId).toBe(BRICK_ID);
      expect(trigger.p95Ms).toBe(12000);
    }
  });

  it("returns undefined at threshold boundary (latency equals threshold)", () => {
    const atThreshold: ToolHealthSnapshot = {
      ...fastSnapshot,
      metrics: { ...fastSnapshot.metrics, avgLatencyMs: 10000 },
    };
    expect(detectAgentLatencyDegradation("code", BRICK_ID, atThreshold, 10000)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// User correction detection (Phase 2B)
// ---------------------------------------------------------------------------

describe("detectUserCorrection", () => {
  it("returns undefined when no correction pattern matches", () => {
    expect(
      detectUserCorrection("Great work, thanks!", DEFAULT_USER_CORRECTION_PATTERNS, "tool-a"),
    ).toBeUndefined();
  });

  it("detects 'that's not right' pattern", () => {
    const trigger = detectUserCorrection(
      "No, that's not right, try again",
      DEFAULT_USER_CORRECTION_PATTERNS,
      "tool-a",
    );
    expect(trigger).toBeDefined();
    expect(trigger?.kind).toBe("user_correction");
    if (trigger?.kind === "user_correction") {
      expect(trigger.correctedToolCall).toBe("tool-a");
      expect(trigger.correctionText).toContain("not right");
    }
  });

  it("detects 'actually you should' pattern", () => {
    const trigger = detectUserCorrection(
      "Actually, you should use the other endpoint",
      DEFAULT_USER_CORRECTION_PATTERNS,
      "fetch-api",
    );
    expect(trigger).toBeDefined();
    expect(trigger?.kind).toBe("user_correction");
  });

  it("detects 'don't do that' pattern", () => {
    const trigger = detectUserCorrection(
      "Don't use that approach",
      DEFAULT_USER_CORRECTION_PATTERNS,
      "tool-b",
    );
    expect(trigger).toBeDefined();
    expect(trigger?.kind).toBe("user_correction");
  });

  it("detects 'I said' pattern", () => {
    const trigger = detectUserCorrection(
      "I said to use the database directly",
      DEFAULT_USER_CORRECTION_PATTERNS,
      "tool-c",
    );
    expect(trigger).toBeDefined();
    expect(trigger?.kind).toBe("user_correction");
  });

  it("truncates long correction text to 200 chars", () => {
    const longText = `Actually, you should ${"x".repeat(300)}`;
    const trigger = detectUserCorrection(longText, DEFAULT_USER_CORRECTION_PATTERNS, "tool-a");
    expect(trigger).toBeDefined();
    if (trigger?.kind === "user_correction") {
      expect(trigger.correctionText.length).toBeLessThanOrEqual(200);
    }
  });

  it("works with custom patterns", () => {
    const customPatterns = [/WRONG ANSWER/i];
    expect(detectUserCorrection("That's a WRONG ANSWER", customPatterns, "tool-a")).toBeDefined();
    expect(detectUserCorrection("Good answer", customPatterns, "tool-a")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Complex task completion detection (Phase 2C)
// ---------------------------------------------------------------------------

describe("detectComplexTaskCompletion", () => {
  it("returns undefined when below threshold", () => {
    expect(detectComplexTaskCompletion(3, 2, 5)).toBeUndefined();
  });

  it("returns trigger when at threshold", () => {
    const trigger = detectComplexTaskCompletion(5, 3, 5);
    expect(trigger).toBeDefined();
    expect(trigger?.kind).toBe("complex_task_completed");
    if (trigger?.kind === "complex_task_completed") {
      expect(trigger.toolCallCount).toBe(5);
      expect(trigger.turnCount).toBe(3);
    }
  });

  it("returns trigger when above threshold", () => {
    const trigger = detectComplexTaskCompletion(15, 8, 5);
    expect(trigger).toBeDefined();
    if (trigger?.kind === "complex_task_completed") {
      expect(trigger.toolCallCount).toBe(15);
      expect(trigger.turnCount).toBe(8);
    }
  });
});

// ---------------------------------------------------------------------------
// Novel workflow detection
// ---------------------------------------------------------------------------

describe("detectNovelWorkflow", () => {
  it("returns undefined when sequence is too short", () => {
    expect(detectNovelWorkflow(["a", "b"], 3)).toBeUndefined();
  });

  it("returns trigger when sequence meets minimum length", () => {
    const trigger = detectNovelWorkflow(["read", "transform", "write"], 3);
    expect(trigger).toBeDefined();
    expect(trigger?.kind).toBe("novel_workflow");
    if (trigger?.kind === "novel_workflow") {
      expect(trigger.toolSequence).toEqual(["read", "transform", "write"]);
    }
  });

  it("returns trigger for longer sequences", () => {
    const trigger = detectNovelWorkflow(["a", "b", "c", "d", "e"], 3);
    expect(trigger).toBeDefined();
    if (trigger?.kind === "novel_workflow") {
      expect(trigger.toolSequence.length).toBe(5);
    }
  });

  it("returns undefined for empty sequence", () => {
    expect(detectNovelWorkflow([], 3)).toBeUndefined();
  });
});
