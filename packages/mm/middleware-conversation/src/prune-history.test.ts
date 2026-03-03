import { describe, expect, test } from "bun:test";
import type { ThreadMessage } from "@koi/core";
import { threadMessageId } from "@koi/core";
import { pruneHistory } from "./prune-history.js";

function makeMsg(id: string, content: string): ThreadMessage {
  return {
    id: threadMessageId(id),
    role: "user",
    content,
    createdAt: Date.now(),
  };
}

describe("pruneHistory", () => {
  test("returns unchanged when under maxMessages", () => {
    const msgs = [makeMsg("1", "a"), makeMsg("2", "b")];
    const result = pruneHistory(msgs, { maxMessages: 5 });

    expect(result).toBe(msgs); // same reference — no copy
  });

  test("returns unchanged when exactly at maxMessages", () => {
    const msgs = [makeMsg("1", "a"), makeMsg("2", "b"), makeMsg("3", "c")];
    const result = pruneHistory(msgs, { maxMessages: 3 });

    expect(result).toBe(msgs);
  });

  test("truncates to newest N when over maxMessages", () => {
    const msgs = [makeMsg("1", "oldest"), makeMsg("2", "middle"), makeMsg("3", "newest")];
    const result = pruneHistory(msgs, { maxMessages: 2 });

    expect(result).toHaveLength(2);
    expect(result[0]?.content).toBe("middle");
    expect(result[1]?.content).toBe("newest");
  });

  test("calls compact callback when provided and over limit", () => {
    const msgs = [makeMsg("1", "a"), makeMsg("2", "b"), makeMsg("3", "c")];
    const compact = (messages: readonly ThreadMessage[]): readonly ThreadMessage[] =>
      messages.filter((m) => m.content !== "b");

    const result = pruneHistory(msgs, { maxMessages: 2, compact });

    expect(result).toHaveLength(2);
    expect(result[0]?.content).toBe("a");
    expect(result[1]?.content).toBe("c");
  });

  test("handles empty array", () => {
    const result = pruneHistory([], { maxMessages: 10 });

    expect(result).toEqual([]);
  });

  test("handles maxMessages = 0", () => {
    const msgs = [makeMsg("1", "a")];
    const result = pruneHistory(msgs, { maxMessages: 0 });

    expect(result).toHaveLength(0);
  });

  test("does not call compact when under limit", () => {
    const msgs = [makeMsg("1", "a")];
    const compact = (): readonly ThreadMessage[] => {
      throw new Error("should not be called");
    };

    const result = pruneHistory(msgs, { maxMessages: 5, compact });

    expect(result).toBe(msgs);
  });
});
