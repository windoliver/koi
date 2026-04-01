/**
 * Optimal split finding tests (ported from v1 with additions).
 */

import { describe, expect, it } from "bun:test";
import type { InboundMessage, TokenEstimator } from "@koi/core";
import { findOptimalSplit } from "./find-split.js";

/** Create a message with known text length. */
function msg(text: string, sender = "user"): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: sender,
    timestamp: Date.now(),
  };
}

/** Simple estimator: 1 char = 1 token. */
const charEstimator: TokenEstimator = {
  estimateText(text: string): number {
    return text.length;
  },
  estimateMessages(messages: readonly InboundMessage[]): number {
    let total = 0; // let: accumulator
    for (const m of messages) {
      for (const b of m.content) {
        if (b.kind === "text") {
          total += b.text.length;
        }
      }
    }
    return total;
  },
};

describe("findOptimalSplit", () => {
  it("returns -1 for empty messages", async () => {
    expect(await findOptimalSplit([], [1], 100, 10, charEstimator)).toBe(-1);
  });

  it("returns -1 for empty validSplitPoints", async () => {
    const messages = [msg("hello")];
    expect(await findOptimalSplit(messages, [], 100, 10, charEstimator)).toBe(-1);
  });

  it("finds optimal split where tail + summary fits", async () => {
    // 5 messages, each 20 chars (20 tokens each)
    const messages = Array.from({ length: 5 }, () => msg("a".repeat(20)));
    // Total: 100 tokens. Window: 80, summary budget: 20
    // Budget for tail: 80 - 20 = 60 tokens
    // Algorithm prefers most aggressive (largest index):
    // Split at 3: tail = [3,4] = 40 ≤ 60 ✓ (most aggressive)
    const validPoints = [1, 2, 3];
    const result = await findOptimalSplit(messages, validPoints, 80, 20, charEstimator);
    expect(result).toBe(3);
  });

  it("prefers most aggressive split (largest index)", async () => {
    // 4 messages, 10 tokens each = 40 total
    const messages = Array.from({ length: 4 }, () => msg("a".repeat(10)));
    // Window: 50, summary: 10. Budget for tail: 40.
    // Split at 3: tail = [3] = 10 ≤ 40 ✓
    // Split at 2: tail = [2,3] = 20 ≤ 40 ✓
    // Should pick 3 (most aggressive)
    const result = await findOptimalSplit(messages, [1, 2, 3], 50, 10, charEstimator);
    expect(result).toBe(3);
  });

  it("returns -1 when no split fits budget", async () => {
    // 2 messages, 100 tokens each = 200 total
    const messages = [msg("a".repeat(100)), msg("b".repeat(100))];
    // Window: 50, summary: 10. Budget for tail: 40.
    // Split at 1: tail = [1] = 100 > 40 ✗
    const result = await findOptimalSplit(messages, [1], 50, 10, charEstimator);
    expect(result).toBe(-1);
  });

  it("handles single message", async () => {
    const messages = [msg("a".repeat(10))];
    // Split at 1 would leave 0 tail messages = 0 tokens
    const result = await findOptimalSplit(messages, [1], 100, 10, charEstimator);
    // Tail = 0 tokens, fits budget (100 - 10 = 90)
    // But there are no messages to summarize... split at 1 means summarize [0], tail empty
    // This is still valid per the algorithm
    expect(result).toBe(1);
  });

  it("handles non-text content blocks gracefully", async () => {
    const messages: InboundMessage[] = [
      {
        content: [{ kind: "image", url: "http://example.com/img.png" }],
        senderId: "user",
        timestamp: Date.now(),
      },
      msg("hello"),
    ];
    // Image block has 0 text tokens, "hello" = 5 tokens
    const result = await findOptimalSplit(messages, [1], 100, 10, charEstimator);
    expect(result).toBe(1);
  });
});
