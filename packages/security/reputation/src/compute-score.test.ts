import { describe, expect, test } from "bun:test";
import type { FeedbackKind, ReputationFeedback, ReputationScore } from "@koi/core";
import { agentId } from "@koi/core";

import { computeScore, DEFAULT_FEEDBACK_WEIGHTS } from "./compute-score.js";

const AGENT_A = agentId("agent-a");
const AGENT_B = agentId("agent-b");

function makeFeedback(kind: FeedbackKind, timestamp = Date.now()): ReputationFeedback {
  return { sourceId: AGENT_B, targetId: AGENT_A, kind, timestamp };
}

/** Narrow undefined away so subsequent expects don't need `!`. */
function assertDefined(value: ReputationScore | undefined): asserts value is ReputationScore {
  expect(value).toBeDefined();
}

describe("computeScore", () => {
  test("returns undefined for empty entries", () => {
    expect(computeScore(AGENT_A, [])).toBeUndefined();
  });

  test("returns score=1.0, level=high for all-positive feedback", () => {
    const entries = [makeFeedback("positive"), makeFeedback("positive"), makeFeedback("positive")];
    const result = computeScore(AGENT_A, entries);
    assertDefined(result);
    expect(result.score).toBe(1.0);
    expect(result.level).toBe("high");
    expect(result.feedbackCount).toBe(3);
    expect(result.agentId).toBe(AGENT_A);
  });

  test("returns score=0.0, level=untrusted for all-negative feedback", () => {
    const entries = [makeFeedback("negative"), makeFeedback("negative")];
    const result = computeScore(AGENT_A, entries);
    assertDefined(result);
    expect(result.score).toBe(0.0);
    expect(result.level).toBe("untrusted");
  });

  test("returns score=0.5, level=medium for all-neutral feedback", () => {
    const entries = [makeFeedback("neutral"), makeFeedback("neutral")];
    const result = computeScore(AGENT_A, entries);
    assertDefined(result);
    expect(result.score).toBe(0.5);
    expect(result.level).toBe("medium");
  });

  test("computes weighted average for mixed feedback", () => {
    // 1 positive (1.0), 1 neutral (0.5), 1 negative (0.0) → avg = 0.5
    const entries = [makeFeedback("positive"), makeFeedback("neutral"), makeFeedback("negative")];
    const result = computeScore(AGENT_A, entries);
    assertDefined(result);
    expect(result.score).toBe(0.5);
    expect(result.level).toBe("medium");
  });

  test("level=untrusted when score < 0.2", () => {
    // 1 neutral (0.5), 4 negative (0.0) → avg = 0.1
    const entries = [
      makeFeedback("neutral"),
      makeFeedback("negative"),
      makeFeedback("negative"),
      makeFeedback("negative"),
      makeFeedback("negative"),
    ];
    const result = computeScore(AGENT_A, entries);
    assertDefined(result);
    expect(result.score).toBe(0.1);
    expect(result.level).toBe("untrusted");
  });

  test("level=low when 0.2 <= score < 0.4", () => {
    // 3 negative (0.0), 1 positive (1.0) → avg = 0.25
    const entries = [
      makeFeedback("negative"),
      makeFeedback("negative"),
      makeFeedback("negative"),
      makeFeedback("positive"),
    ];
    const result = computeScore(AGENT_A, entries);
    assertDefined(result);
    expect(result.score).toBe(0.25);
    expect(result.level).toBe("low");
  });

  test("level=medium when 0.4 <= score < 0.6", () => {
    // 1 positive (1.0), 1 negative (0.0) → avg = 0.5
    const entries = [makeFeedback("positive"), makeFeedback("negative")];
    const result = computeScore(AGENT_A, entries);
    assertDefined(result);
    expect(result.score).toBe(0.5);
    expect(result.level).toBe("medium");
  });

  test("level=high when score >= 0.6", () => {
    // 2 positive (1.0), 1 negative (0.0) → avg = 0.666...
    const entries = [makeFeedback("positive"), makeFeedback("positive"), makeFeedback("negative")];
    const result = computeScore(AGENT_A, entries);
    assertDefined(result);
    expect(result.score).toBeCloseTo(0.6667, 3);
    expect(result.level).toBe("high");
  });

  test("never assigns 'verified' level", () => {
    const result = computeScore(AGENT_A, [makeFeedback("positive")]);
    assertDefined(result);
    expect(result.level).not.toBe("verified");
  });

  test("respects custom weights", () => {
    const customWeights: Record<FeedbackKind, number> = {
      positive: 1.0,
      neutral: 0.8,
      negative: 0.2,
    };
    // 1 negative with weight 0.2 → avg = 0.2 → level = low
    const entries = [makeFeedback("negative")];
    const result = computeScore(AGENT_A, entries, customWeights);
    assertDefined(result);
    expect(result.score).toBe(0.2);
    expect(result.level).toBe("low");
  });

  test("DEFAULT_FEEDBACK_WEIGHTS has expected values", () => {
    expect(DEFAULT_FEEDBACK_WEIGHTS.positive).toBe(1.0);
    expect(DEFAULT_FEEDBACK_WEIGHTS.neutral).toBe(0.5);
    expect(DEFAULT_FEEDBACK_WEIGHTS.negative).toBe(0.0);
  });

  test("populates computedAt timestamp", () => {
    const before = Date.now();
    const result = computeScore(AGENT_A, [makeFeedback("positive")]);
    const after = Date.now();
    assertDefined(result);
    expect(result.computedAt).toBeGreaterThanOrEqual(before);
    expect(result.computedAt).toBeLessThanOrEqual(after);
  });
});
