import { describe, expect, test } from "bun:test";
import { heuristicTokenEstimator } from "./estimator.js";

describe("heuristicTokenEstimator", () => {
  describe("estimateText", () => {
    test("estimates 4 chars as 1 token", () => {
      expect(heuristicTokenEstimator.estimateText("abcd")).toBe(1);
    });

    test("rounds up partial tokens", () => {
      expect(heuristicTokenEstimator.estimateText("abc")).toBe(1);
      expect(heuristicTokenEstimator.estimateText("abcde")).toBe(2);
    });

    test("returns 0 for empty string", () => {
      expect(heuristicTokenEstimator.estimateText("")).toBe(0);
    });

    test("estimates longer text proportionally", () => {
      const text = "a".repeat(400);
      expect(heuristicTokenEstimator.estimateText(text)).toBe(100);
    });

    test("handles single character", () => {
      expect(heuristicTokenEstimator.estimateText("a")).toBe(1);
    });
  });

  describe("estimateMessages", () => {
    test("sums token counts across messages and text blocks", () => {
      const messages = [
        {
          content: [{ kind: "text" as const, text: "abcd" }],
          senderId: "user",
          timestamp: 0,
        },
        {
          content: [{ kind: "text" as const, text: "efghijkl" }],
          senderId: "agent",
          timestamp: 1,
        },
      ];
      // "abcd" = 1 token, "efghijkl" = 2 tokens
      expect(heuristicTokenEstimator.estimateMessages(messages)).toBe(3);
    });

    test("skips non-text blocks", () => {
      const messages = [
        {
          content: [
            { kind: "text" as const, text: "abcd" },
            { kind: "image" as const, url: "https://example.com/img.png" },
          ],
          senderId: "user",
          timestamp: 0,
        },
      ];
      expect(heuristicTokenEstimator.estimateMessages(messages)).toBe(1);
    });

    test("returns 0 for empty messages", () => {
      expect(heuristicTokenEstimator.estimateMessages([])).toBe(0);
    });

    test("handles messages with empty content", () => {
      const messages = [{ content: [], senderId: "user", timestamp: 0 }];
      expect(heuristicTokenEstimator.estimateMessages(messages)).toBe(0);
    });
  });
});
