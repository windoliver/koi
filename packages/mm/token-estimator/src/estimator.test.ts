import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core";
import {
  CHARS_PER_TOKEN,
  createHeuristicEstimator,
  estimateTokens,
  HEURISTIC_ESTIMATOR,
} from "./estimator.js";

// ---------------------------------------------------------------------------
// createHeuristicEstimator — estimateText
// ---------------------------------------------------------------------------

describe("createHeuristicEstimator", () => {
  const estimator = createHeuristicEstimator();

  describe("estimateText", () => {
    test("returns 0 for empty string", () => {
      expect(estimator.estimateText("")).toBe(0);
    });

    test("returns 1 for single character", () => {
      expect(estimator.estimateText("a")).toBe(1);
    });

    test("returns 1 for exact 4-char string", () => {
      expect(estimator.estimateText("abcd")).toBe(1);
    });

    test("rounds up partial tokens", () => {
      expect(estimator.estimateText("abcde")).toBe(2);
    });

    test("exact multiple — no rounding", () => {
      expect(estimator.estimateText("a".repeat(400))).toBe(100);
    });

    test("handles Unicode CJK strings via UTF-16 length", () => {
      // Each CJK char is 1 UTF-16 code unit, so 4 CJK chars = 1 token
      expect(estimator.estimateText("\u4F60\u597D\u4E16\u754C")).toBe(1);
    });

    test("handles whitespace-only strings", () => {
      expect(estimator.estimateText("    ")).toBe(1);
      expect(estimator.estimateText("     ")).toBe(2);
    });

    test("model parameter is accepted but ignored", () => {
      expect(estimator.estimateText("abcd", "gpt-4")).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // createHeuristicEstimator — estimateMessages
  // ---------------------------------------------------------------------------

  describe("estimateMessages", () => {
    test("returns 0 for empty array", () => {
      expect(estimator.estimateMessages([])).toBe(0);
    });

    test("adds perMessageOverhead for message with empty content", () => {
      const msgs: readonly InboundMessage[] = [{ content: [], senderId: "user", timestamp: 0 }];
      // 0 text tokens + 4 per-message overhead
      expect(estimator.estimateMessages(msgs)).toBe(4);
    });

    test("estimates text-only blocks", () => {
      const msgs: readonly InboundMessage[] = [
        { content: [{ kind: "text", text: "abcd" }], senderId: "user", timestamp: 0 },
      ];
      // 1 text token + 4 per-message overhead
      expect(estimator.estimateMessages(msgs)).toBe(5);
    });

    test("adds overhead for non-text blocks", () => {
      const msgs: readonly InboundMessage[] = [
        {
          content: [
            { kind: "text", text: "abcd" },
            { kind: "image", url: "https://example.com/img.png" },
          ],
          senderId: "user",
          timestamp: 0,
        },
      ];
      // 1 text token + 100 image overhead + 4 per-message overhead
      expect(estimator.estimateMessages(msgs)).toBe(105);
    });

    test("sums correctly across multiple messages", () => {
      const msgs: readonly InboundMessage[] = [
        { content: [{ kind: "text", text: "abcd" }], senderId: "user", timestamp: 0 },
        { content: [{ kind: "text", text: "efghijkl" }], senderId: "agent", timestamp: 1 },
      ];
      // msg1: 1 text + 4 overhead = 5; msg2: 2 text + 4 overhead = 6; total = 11
      expect(estimator.estimateMessages(msgs)).toBe(11);
    });

    test("mixed blocks with non-text content", () => {
      const msgs: readonly InboundMessage[] = [
        {
          content: [
            { kind: "text", text: "a".repeat(8) },
            { kind: "image", url: "https://example.com/a.png" },
            { kind: "custom", type: "tool_result", data: {} },
          ],
          senderId: "agent",
          timestamp: 0,
        },
      ];
      // 2 text tokens + 100 image + 100 custom + 4 overhead = 206
      expect(estimator.estimateMessages(msgs)).toBe(206);
    });

    test("model parameter is accepted but ignored", () => {
      const msgs: readonly InboundMessage[] = [
        { content: [{ kind: "text", text: "abcd" }], senderId: "user", timestamp: 0 },
      ];
      expect(estimator.estimateMessages(msgs, "gpt-4")).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------
  // Custom config
  // ---------------------------------------------------------------------------

  describe("custom config", () => {
    test("override charsPerToken", () => {
      const est = createHeuristicEstimator({ charsPerToken: 6 });
      // 6 chars / 6 cpt = 1 token
      expect(est.estimateText("abcdef")).toBe(1);
      // 7 chars / 6 cpt = ceil(1.17) = 2
      expect(est.estimateText("abcdefg")).toBe(2);
    });

    test("override perMessageOverhead", () => {
      const est = createHeuristicEstimator({ perMessageOverhead: 10 });
      const msgs: readonly InboundMessage[] = [{ content: [], senderId: "user", timestamp: 0 }];
      expect(est.estimateMessages(msgs)).toBe(10);
    });

    test("override perNonTextBlockOverhead", () => {
      const est = createHeuristicEstimator({ perNonTextBlockOverhead: 50 });
      const msgs: readonly InboundMessage[] = [
        {
          content: [{ kind: "image", url: "https://example.com/img.png" }],
          senderId: "user",
          timestamp: 0,
        },
      ];
      // 50 image overhead + 4 per-message overhead
      expect(est.estimateMessages(msgs)).toBe(54);
    });
  });
});

// ---------------------------------------------------------------------------
// estimateTokens (bare function)
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  test("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("estimates at 4 chars per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });

  test("rounds up", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  test("handles longer text proportionally", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// HEURISTIC_ESTIMATOR (singleton)
// ---------------------------------------------------------------------------

describe("HEURISTIC_ESTIMATOR", () => {
  test("has estimateText and estimateMessages", () => {
    expect(typeof HEURISTIC_ESTIMATOR.estimateText).toBe("function");
    expect(typeof HEURISTIC_ESTIMATOR.estimateMessages).toBe("function");
  });

  test("returns same results as createHeuristicEstimator()", () => {
    const fresh = createHeuristicEstimator();
    expect(HEURISTIC_ESTIMATOR.estimateText("hello world")).toBe(fresh.estimateText("hello world"));
  });
});

// ---------------------------------------------------------------------------
// CHARS_PER_TOKEN constant
// ---------------------------------------------------------------------------

describe("CHARS_PER_TOKEN", () => {
  test("equals 4", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("createHeuristicEstimator input validation", () => {
  test("throws for charsPerToken = 0", () => {
    expect(() => createHeuristicEstimator({ charsPerToken: 0 })).toThrow(
      "charsPerToken must be positive",
    );
  });

  test("throws for negative charsPerToken", () => {
    expect(() => createHeuristicEstimator({ charsPerToken: -1 })).toThrow(
      "charsPerToken must be positive",
    );
  });

  test("throws for negative perMessageOverhead", () => {
    expect(() => createHeuristicEstimator({ perMessageOverhead: -1 })).toThrow(
      "perMessageOverhead must be non-negative",
    );
  });

  test("throws for negative perNonTextBlockOverhead", () => {
    expect(() => createHeuristicEstimator({ perNonTextBlockOverhead: -1 })).toThrow(
      "perNonTextBlockOverhead must be non-negative",
    );
  });

  test("accepts zero overhead values", () => {
    const est = createHeuristicEstimator({ perMessageOverhead: 0, perNonTextBlockOverhead: 0 });
    expect(est.estimateText("abcd")).toBe(1);
  });
});
