/**
 * Microcompact tests — truncation strategy.
 */

import { describe, expect, it } from "bun:test";
import { charEstimator, textMsg as msg } from "./__tests__/test-helpers.js";
import { microcompact } from "./micro-compact.js";

describe("microcompact", () => {
  it("returns noop when already below target", async () => {
    // 3 messages, 10 tokens each = 30 total, target = 50
    const messages = [msg("a".repeat(10)), msg("b".repeat(10)), msg("c".repeat(10))];
    const result = await microcompact(messages, 50, 2, charEstimator);
    expect(result.strategy).toBe("noop");
    expect(result.messages).toEqual(messages);
  });

  it("truncates oldest messages to reach target", async () => {
    // 5 messages, 20 tokens each = 100 total, target = 60, preserve 2
    const messages = [
      msg("a".repeat(20)),
      msg("b".repeat(20)),
      msg("c".repeat(20)),
      msg("d".repeat(20)),
      msg("e".repeat(20)),
    ];
    const result = await microcompact(messages, 60, 2, charEstimator);
    expect(result.strategy).toBe("micro-truncate");
    // Should drop first 2 messages: remaining = [c, d, e] = 60 tokens
    expect(result.messages.length).toBe(3);
    expect(result.compactedTokens).toBe(60);
    expect(result.originalTokens).toBe(100);
  });

  it("preserves at least preserveRecent messages", async () => {
    // 4 messages, 30 tokens each = 120 total, target = 30, preserve 3
    // Even though target wants us below 30, we can only drop 1 message
    const messages = [
      msg("a".repeat(30)),
      msg("b".repeat(30)),
      msg("c".repeat(30)),
      msg("d".repeat(30)),
    ];
    const result = await microcompact(messages, 30, 3, charEstimator);
    expect(result.messages.length).toBe(3); // preserved 3, dropped 1
    expect(result.compactedTokens).toBe(90);
  });

  it("returns noop when all messages are within preserveRecent", async () => {
    const messages = [msg("a".repeat(50)), msg("b".repeat(50))];
    const result = await microcompact(messages, 30, 3, charEstimator);
    expect(result.strategy).toBe("noop");
  });

  it("respects pair boundaries during truncation", async () => {
    // [assistant(c1), tool(c1), user, assistant, user]
    // Pair [0,1] must not be split — first valid split is at index 2.
    const messages = [
      {
        content: [{ kind: "custom" as const, type: "tool_use", data: { id: "c1", name: "test" } }],
        senderId: "assistant",
        timestamp: Date.now(),
        metadata: { callId: "c1" },
      },
      msg("a".repeat(20), "tool", "c1"), // 20 tokens
      msg("b".repeat(10)), // 10 tokens
      msg("c".repeat(10), "assistant"), // 10 tokens
      msg("d".repeat(10)), // 10 tokens
    ];
    // Total: 0 + 20 + 10 + 10 + 10 = 50, target = 35, preserve 2
    // Valid splits (preserve 2, max split = 3): [2, 3]
    //   Split at 1: interior (pair), invalid
    //   Split at 2: tail = [2,3,4] = 30 ≤ 35 ✓ ← smallest valid
    const result = await microcompact(messages, 35, 2, charEstimator);
    expect(result.strategy).toBe("micro-truncate");
    // Dropped pair [0,1], kept [2,3,4]
    expect(result.messages[0]).toBe(messages[2]);
    expect(result.messages.length).toBe(3);
  });

  it("preserves pinned messages from dropped head", async () => {
    // [pinned_system(5), user(20), user(20), user(20), user(20)]
    // total: 85, target: 50, preserve 2
    // Split at 3: head = [pinned(5), 20, 20], tail = [20, 20]
    // rescued: [pinned(5), 20, 20] = 45 ≤ 50 ✓
    const messages = [
      msg("a".repeat(5), "system", undefined, true), // pinned, small
      msg("b".repeat(20)),
      msg("c".repeat(20)),
      msg("d".repeat(20)),
      msg("e".repeat(20)),
    ];
    const result = await microcompact(messages, 50, 2, charEstimator);
    expect(result.strategy).toBe("micro-truncate");
    // Pinned message must be preserved even though it was in the head
    const hasPinned = result.messages.some((m) => m.pinned === true);
    expect(hasPinned).toBe(true);
  });

  it("preserves pinned at index 0 — compaction still makes progress", async () => {
    // Regression: pinned at index 0 must not block all compaction
    const messages = [
      msg("a".repeat(10), "system", undefined, true), // pinned
      msg("b".repeat(30)),
      msg("c".repeat(30)),
      msg("d".repeat(10)),
      msg("e".repeat(10)),
    ];
    // total: 90, target: 50, preserve 2
    const result = await microcompact(messages, 50, 2, charEstimator);
    // Should be able to drop some messages even with pinned at 0
    expect(result.strategy).not.toBe("noop");
    expect(result.messages.length).toBeLessThan(messages.length);
    // Pinned must survive
    expect(result.messages.some((m) => m.pinned === true)).toBe(true);
  });

  it("returns micro-truncate-partial when target cannot be reached", async () => {
    // 4 messages, 30 tokens each = 120 total, target = 10, preserve 3
    // Can only drop 1 message, leaving 90 tokens — still over 10
    const messages = [
      msg("a".repeat(30)),
      msg("b".repeat(30)),
      msg("c".repeat(30)),
      msg("d".repeat(30)),
    ];
    const result = await microcompact(messages, 10, 3, charEstimator);
    expect(result.strategy).toBe("micro-truncate-partial");
    expect(result.compactedTokens).toBeGreaterThan(10);
    expect(result.messages.length).toBe(3);
  });

  it("reports correct token counts", async () => {
    const messages = [msg("a".repeat(40)), msg("b".repeat(30)), msg("c".repeat(20))];
    // total: 90, target: 50, preserve 1
    const result = await microcompact(messages, 50, 1, charEstimator);
    expect(result.originalTokens).toBe(90);
    expect(result.compactedTokens).toBeLessThanOrEqual(50);
  });
});
