/**
 * Integration tests — policy + estimator + microcompact pipeline.
 *
 * Tests the full decision → compaction flow with mock estimator
 * and realistic message sequences.
 */

import { describe, expect, it } from "bun:test";
import { createBackoffTracker } from "../backoff.js";
import { findOptimalSplit } from "../find-split.js";
import { microcompact } from "../micro-compact.js";
import { shouldCompact } from "../policy.js";
import { createPressureTrendTracker } from "../pressure-trend.js";
import type { CompactionState } from "../types.js";
import { INITIAL_STATE } from "../types.js";
import { charEstimator, textMsg as msg, overheadEstimator } from "./test-helpers.js";

describe("integration: policy → microcompact pipeline", () => {
  const WINDOW = 100;
  const SOFT = 0.5;
  const HARD = 0.75;
  const TARGET = 0.35;

  it("noop when below soft threshold", () => {
    const decision = shouldCompact(40, WINDOW, SOFT, HARD);
    expect(decision).toBe("noop");
  });

  it("microcompact triggers and truncates at soft threshold", async () => {
    // 55 tokens > 50% of 100
    const messages = [
      msg("a".repeat(15)),
      msg("b".repeat(15)),
      msg("c".repeat(10)),
      msg("d".repeat(15)),
    ];
    const total = charEstimator.estimateMessages(messages) as number;
    expect(total).toBe(55);

    const decision = shouldCompact(total, WINDOW, SOFT, HARD);
    expect(decision).toBe("micro");

    const targetTokens = Math.floor(WINDOW * TARGET); // 35
    const result = await microcompact(messages, targetTokens, 2, charEstimator);
    expect(result.strategy).toBe("micro-truncate");
    expect(result.compactedTokens).toBeLessThanOrEqual(targetTokens);
  });

  it("full compact decision at hard threshold", () => {
    const decision = shouldCompact(75, WINDOW, SOFT, HARD);
    expect(decision).toBe("full");
  });

  it("backoff prevents compaction during skip period", () => {
    const tracker = createBackoffTracker(1, 32);

    // Simulate failure at turn 5
    let state: CompactionState = { ...INITIAL_STATE, currentTurn: 5 };
    state = tracker.recordFailure(state);
    expect(state.skipUntilTurn).toBe(6);

    // Turn 5: failure turn, still within backoff
    expect(tracker.shouldSkip({ ...state, currentTurn: 5 })).toBe(true);

    // Turn 6: skipUntilTurn is inclusive — still skipped
    expect(tracker.shouldSkip({ ...state, currentTurn: 6 })).toBe(true);

    // Turn 7: backoff expired, retry
    expect(tracker.shouldSkip({ ...state, currentTurn: 7 })).toBe(false);
  });

  it("pressure trend tracks growth across turns", () => {
    const trend = createPressureTrendTracker();
    trend.record(20);
    trend.record(30);
    trend.record(40);

    const snapshot = trend.compute(100);
    expect(snapshot.growthPerTurn).toBe(10);
    expect(snapshot.estimatedTurnsToCompaction).toBe(6); // (100-40)/10 = 6
  });

  it("dual-trigger: above hard threshold → full, not micro", () => {
    // When above hard, should return "full" even though also above soft
    const decision = shouldCompact(80, WINDOW, SOFT, HARD);
    expect(decision).toBe("full");
  });

  it("edge: compaction result with more tokens than original returns noop", async () => {
    // Messages already below target
    const messages = [msg("a".repeat(10))];
    const result = await microcompact(messages, 50, 1, charEstimator);
    expect(result.strategy).toBe("noop");
    expect(result.compactedTokens).toBe(result.originalTokens);
  });

  it("edge: no valid split points returns noop", async () => {
    // All messages within preserveRecent
    const messages = [msg("a".repeat(30)), msg("b".repeat(30))];
    const result = await microcompact(messages, 20, 4, charEstimator);
    expect(result.strategy).toBe("noop");
  });
});

describe("non-additive estimator support", () => {
  it("findOptimalSplit uses real tail estimate, not prefix-sum subtraction", async () => {
    // 4 messages, 20 chars each
    // Singleton estimates: est([m]) = 20 + 10 = 30 each → sum = 120
    // Real estimate for tail of 2: est([m3, m4]) = 40 + 10 = 50
    // Budget: 80 - 10 = 70
    // Prefix-sum approach would compute tail of 2 as: 120 - 60 = 60 (wrong, undercounts)
    // Real approach: est([m3, m4]) = 50 ≤ 70 ✓
    const messages = Array.from({ length: 4 }, () => msg("a".repeat(20)));
    const result = await findOptimalSplit(messages, [1, 2, 3], 80, 10, overheadEstimator);
    // Should find a valid split (not -1)
    expect(result).toBeGreaterThanOrEqual(1);

    // Verify the actual tail fits the budget
    const tail = messages.slice(result);
    const tailTokens = overheadEstimator.estimateMessages(tail) as number;
    expect(tailTokens).toBeLessThanOrEqual(70);
  });

  it("microcompact reports accurate compactedTokens with non-additive estimator", async () => {
    // 5 messages, 20 chars each
    // Full sequence: est([all]) = 100 + 10 = 110
    // Target: 60
    const messages = Array.from({ length: 5 }, () => msg("a".repeat(20)));
    const result = await microcompact(messages, 60, 2, overheadEstimator);
    expect(result.strategy).toBe("micro-truncate");

    // compactedTokens must match actual estimateMessages(tail)
    const realTailTokens = overheadEstimator.estimateMessages(result.messages) as number;
    expect(result.compactedTokens).toBe(realTailTokens);
    expect(result.compactedTokens).toBeLessThanOrEqual(60);
  });
});
