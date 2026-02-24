import { describe, expect, test } from "bun:test";
import type { TokenEstimator } from "@koi/core/context";
import type { InboundMessage } from "@koi/core/message";
import { findOptimalSplit } from "./find-split.js";

/** Create a message with `n` characters of text (n/4 tokens at 4 chars/token). */
function msgWithTokens(tokenCount: number): InboundMessage {
  const text = "x".repeat(tokenCount * 4);
  return { content: [{ kind: "text", text }], senderId: "user", timestamp: 1 };
}

/** Deterministic estimator: 4 chars = 1 token. */
const estimator: TokenEstimator = {
  estimateText(text: string): number {
    return Math.ceil(text.length / 4);
  },
  estimateMessages(messages: readonly InboundMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.kind === "text") {
          total += Math.ceil(block.text.length / 4);
        }
      }
    }
    return total;
  },
};

describe("findOptimalSplit", () => {
  test("returns -1 when no valid split points", async () => {
    const msgs = [msgWithTokens(100), msgWithTokens(100)];
    const result = await findOptimalSplit(msgs, [], 500, 50, estimator);
    expect(result).toBe(-1);
  });

  test("returns -1 when empty messages", async () => {
    const result = await findOptimalSplit([], [], 500, 50, estimator);
    expect(result).toBe(-1);
  });

  test("returns largest valid split that fits budget", async () => {
    // 5 messages, each 100 tokens = 500 total
    const msgs = [
      msgWithTokens(100),
      msgWithTokens(100),
      msgWithTokens(100),
      msgWithTokens(100),
      msgWithTokens(100),
    ];
    const validSplits = [1, 2, 3, 4];
    // contextWindowSize = 350, maxSummaryTokens = 50
    // Split at 4: tail = msgs[4] = 100 tokens. 100 + 50 = 150 <= 350. ✓
    // We want the largest (most aggressive compaction = smallest tail).
    // Algorithm scans from largest split index → picks 4.
    const result = await findOptimalSplit(msgs, validSplits, 350, 50, estimator);
    expect(result).toBe(4);
  });

  test("falls back to smaller split when largest does not fit", async () => {
    // 4 messages: [200, 200, 200, 200] = 800 tokens
    const msgs = [msgWithTokens(200), msgWithTokens(200), msgWithTokens(200), msgWithTokens(200)];
    const validSplits = [1, 2, 3];
    // Split at 3: tail = msgs[3] = 200. 200+50=250 <= 300. ✓
    const result = await findOptimalSplit(msgs, validSplits, 300, 50, estimator);
    expect(result).toBe(3);
  });

  test("returns -1 when no split fits the budget", async () => {
    const msgs = [msgWithTokens(500), msgWithTokens(500)];
    const validSplits = [1];
    const result = await findOptimalSplit(msgs, validSplits, 100, 50, estimator);
    expect(result).toBe(-1);
  });

  test("prefix sums correctly handle mixed-size messages", async () => {
    const msgs = [
      msgWithTokens(10),
      msgWithTokens(50),
      msgWithTokens(200),
      msgWithTokens(30),
      msgWithTokens(10),
    ];
    const validSplits = [1, 2, 3, 4];
    // Split at 4: tail = 10. 10+20=30 <= 100. ✓
    const result = await findOptimalSplit(msgs, validSplits, 100, 20, estimator);
    expect(result).toBe(4);
  });

  test("single valid split point that fits", async () => {
    const msgs = [msgWithTokens(100), msgWithTokens(100)];
    const validSplits = [1];
    const result = await findOptimalSplit(msgs, validSplits, 200, 50, estimator);
    expect(result).toBe(1);
  });
});
