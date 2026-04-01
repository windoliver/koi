import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core";
import { estimateTokens, reorderForCache } from "./reorder.js";

function msg(senderId: string, text: string): InboundMessage {
  return {
    senderId,
    content: [{ kind: "text", text }],
    timestamp: Date.now(),
  };
}

describe("reorderForCache", () => {
  test("empty messages returns empty result", () => {
    const result = reorderForCache([]);
    expect(result.messages).toEqual([]);
    expect(result.lastStableIndex).toBe(-1);
    expect(result.staticCount).toBe(0);
  });

  test("places system messages before user messages", () => {
    const messages = [msg("user", "hello"), msg("system", "you are helpful"), msg("user", "bye")];
    const result = reorderForCache(messages);

    expect(result.messages[0]?.senderId).toBe("system");
    expect(result.messages[1]?.senderId).toBe("user");
    expect(result.messages[2]?.senderId).toBe("user");
    expect(result.staticCount).toBe(1);
    expect(result.lastStableIndex).toBe(0);
  });

  test("treats assistant messages as dynamic (preserves turn order)", () => {
    const messages = [
      msg("user", "hi"),
      msg("assistant", "hello there"),
      msg("system", "instructions"),
    ];
    const result = reorderForCache(messages);

    // system first (static), then user + assistant in original order (dynamic)
    expect(result.messages[0]?.senderId).toBe("system");
    expect(result.messages[1]?.senderId).toBe("user");
    expect(result.messages[2]?.senderId).toBe("assistant");
    expect(result.staticCount).toBe(1);
    expect(result.lastStableIndex).toBe(0);
  });

  test("preserves relative order within groups", () => {
    const messages = [
      msg("user", "first"),
      msg("system", "a"),
      msg("user", "second"),
      msg("system", "b"),
      msg("user", "third"),
    ];
    const result = reorderForCache(messages);

    // Static group order preserved
    expect(result.messages[0]?.content[0]).toEqual({ kind: "text", text: "a" });
    expect(result.messages[1]?.content[0]).toEqual({ kind: "text", text: "b" });
    // Dynamic group order preserved
    expect(result.messages[2]?.content[0]).toEqual({ kind: "text", text: "first" });
    expect(result.messages[3]?.content[0]).toEqual({ kind: "text", text: "second" });
    expect(result.messages[4]?.content[0]).toEqual({ kind: "text", text: "third" });
  });

  test("all static messages — lastStableIndex is last index", () => {
    const messages = [msg("system", "a"), msg("system:capabilities", "b")];
    const result = reorderForCache(messages);

    expect(result.staticCount).toBe(2);
    expect(result.lastStableIndex).toBe(1);
    expect(result.messages).toHaveLength(2);
  });

  test("all dynamic messages — lastStableIndex is -1", () => {
    const messages = [msg("user", "a"), msg("tool", "b")];
    const result = reorderForCache(messages);

    expect(result.staticCount).toBe(0);
    expect(result.lastStableIndex).toBe(-1);
    expect(result.messages).toHaveLength(2);
  });

  test("single message", () => {
    const result = reorderForCache([msg("system", "only one")]);
    expect(result.staticCount).toBe(1);
    expect(result.lastStableIndex).toBe(0);
    expect(result.messages).toHaveLength(1);
  });

  test("tool sender is treated as dynamic", () => {
    const messages = [msg("tool", "result"), msg("system", "instructions")];
    const result = reorderForCache(messages);

    expect(result.messages[0]?.senderId).toBe("system");
    expect(result.messages[1]?.senderId).toBe("tool");
    expect(result.staticCount).toBe(1);
  });
});

describe("estimateTokens", () => {
  test("empty messages returns 0", () => {
    expect(estimateTokens([])).toBe(0);
  });

  test("estimates roughly 1 token per 4 chars", () => {
    // 100 chars = ~25 tokens
    const messages = [msg("system", "a".repeat(100))];
    expect(estimateTokens(messages)).toBe(25);
  });

  test("sums across multiple messages and blocks", () => {
    const messages = [msg("system", "a".repeat(40)), msg("system", "b".repeat(60))];
    // 100 chars total = 25 tokens
    expect(estimateTokens(messages)).toBe(25);
  });

  test("ignores non-text blocks", () => {
    const messages: InboundMessage[] = [
      {
        senderId: "system",
        content: [
          { kind: "text", text: "a".repeat(40) },
          { kind: "image", url: "https://example.com/img.png" },
        ],
        timestamp: Date.now(),
      },
    ];
    // Only text block counted: 40 chars = 10 tokens
    expect(estimateTokens(messages)).toBe(10);
  });

  test("rounds up", () => {
    // 5 chars → ceil(5/4) = 2
    const messages = [msg("system", "hello")];
    expect(estimateTokens(messages)).toBe(2);
  });
});
