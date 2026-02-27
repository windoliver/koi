import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core/message";
import { findValidSplitPoints } from "./pair-boundaries.js";

function userMsg(text: string, ts = 1): InboundMessage {
  return { content: [{ kind: "text", text }], senderId: "user", timestamp: ts };
}

function assistantMsg(text: string, callId?: string, ts = 2): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "assistant",
    timestamp: ts,
    ...(callId !== undefined ? { metadata: { callId } } : {}),
  };
}

function toolResultMsg(callId: string, text: string, ts = 3): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "tool",
    timestamp: ts,
    metadata: { callId },
  };
}

describe("findValidSplitPoints", () => {
  test("empty messages returns empty split points", () => {
    expect(findValidSplitPoints([], 0)).toEqual([]);
  });

  test("all-user messages — every index is a valid split point", () => {
    const msgs = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];
    // preserveRecent=1 => last 1 message excluded, valid splits at 0,1,2,3
    // But split at 3 would leave only 1 msg in tail (< preserveRecent handled by caller)
    // Actually split points are indices where we can split the array.
    // Split at index i means: [0..i-1] = compacted, [i..end] = preserved.
    // With preserveRecent=1, the latest message (index 3) must be in the tail.
    // So valid split points are: 1, 2, 3 (split before index 1, 2, or 3).
    const result = findValidSplitPoints(msgs, 1);
    expect(result).toEqual([1, 2, 3]);
  });

  test("single assistant+tool pair — split only at pair boundary", () => {
    const msgs = [
      userMsg("hello"),
      assistantMsg("calling tool", "call-1"),
      toolResultMsg("call-1", "result"),
      userMsg("thanks"),
    ];
    // Pair: indices 1,2 form an atomic group.
    // preserveRecent=1 => exclude last 1 message (index 3).
    // Valid split points: 1 (before pair), 3 (after pair, before preserved).
    // Cannot split at 2 — that would break the pair.
    const result = findValidSplitPoints(msgs, 1);
    expect(result).toEqual([1, 3]);
  });

  test("multi-tool call — assistant with multiple tool results", () => {
    const msgs = [
      userMsg("go"),
      assistantMsg("calling tools", "call-a"),
      toolResultMsg("call-a", "result a"),
      // Second tool result for the same assistant turn (different callId but adjacent)
      assistantMsg("more tools", "call-b"),
      toolResultMsg("call-b", "result b"),
      userMsg("done"),
    ];
    // Pairs: [1,2] and [3,4] are atomic groups.
    // preserveRecent=1 => exclude index 5.
    // Valid splits: 1 (before first pair), 3 (between pairs), 5 (after second pair).
    const result = findValidSplitPoints(msgs, 1);
    expect(result).toEqual([1, 3, 5]);
  });

  test("orphan tool result — tool without matching assistant", () => {
    const msgs = [toolResultMsg("orphan-call", "orphan result"), userMsg("after")];
    // Orphan tool result treated as a standalone message (no pair to protect).
    // preserveRecent=1 => exclude index 1.
    // Valid splits: 1.
    const result = findValidSplitPoints(msgs, 1);
    expect(result).toEqual([1]);
  });

  test("orphan assistant — assistant with callId but no matching tool result", () => {
    const msgs = [userMsg("start"), assistantMsg("calling tool", "call-x"), userMsg("end")];
    // No tool result for call-x. Assistant treated as standalone.
    // preserveRecent=1 => exclude index 2.
    // Valid splits: 1, 2.
    const result = findValidSplitPoints(msgs, 1);
    expect(result).toEqual([1, 2]);
  });

  test("preserveRecent=0 — all non-pair-breaking indices valid", () => {
    const msgs = [
      userMsg("a"),
      assistantMsg("call", "c1"),
      toolResultMsg("c1", "res"),
      userMsg("b"),
    ];
    // Pair: [1,2]. Valid: 1, 3, 4.
    const result = findValidSplitPoints(msgs, 0);
    expect(result).toEqual([1, 3, 4]);
  });

  test("preserveRecent covers entire array — no valid splits", () => {
    const msgs = [userMsg("a"), userMsg("b")];
    // preserveRecent=10 => all messages must be preserved.
    const result = findValidSplitPoints(msgs, 10);
    expect(result).toEqual([]);
  });

  test("non-adjacent assistant and tool with same callId", () => {
    const msgs = [
      userMsg("start"),
      assistantMsg("calling", "c1"),
      userMsg("interruption"),
      toolResultMsg("c1", "result"),
      userMsg("end"),
    ];
    // Pair: [1, 3] — indices 1 through 3 are atomic (can't split within).
    // preserveRecent=1 => exclude index 4.
    // Valid splits: 1 (before pair start), 4 (after pair end).
    const result = findValidSplitPoints(msgs, 1);
    expect(result).toEqual([1, 4]);
  });

  test("assistant without callId is standalone — not paired", () => {
    const msgs = [userMsg("start"), assistantMsg("just text, no tool call"), userMsg("end")];
    // No callId => not part of any pair.
    // preserveRecent=1 => exclude index 2.
    // Valid splits: 1, 2.
    const result = findValidSplitPoints(msgs, 1);
    expect(result).toEqual([1, 2]);
  });

  test("pinned message at start — no valid splits (all messages protected)", () => {
    const pinned: InboundMessage = {
      content: [{ kind: "text", text: "harness context" }],
      senderId: "harness",
      timestamp: 1,
      pinned: true,
    };
    const msgs = [pinned, userMsg("a"), userMsg("b"), userMsg("c")];
    // First pinned at index 0 → cap = 0 → no splits possible
    const result = findValidSplitPoints(msgs, 1);
    expect(result).toEqual([]);
  });

  test("pinned message in middle — splits only before it", () => {
    const pinned: InboundMessage = {
      content: [{ kind: "text", text: "harness context" }],
      senderId: "harness",
      timestamp: 1,
      pinned: true,
    };
    const msgs = [userMsg("old-1"), userMsg("old-2"), pinned, userMsg("recent")];
    // First pinned at index 2 → cap = 2, preserveRecent=1 → maxSplit = 3
    // effectiveMax = min(3, 2) = 2 → splits at 1, 2
    const result = findValidSplitPoints(msgs, 1);
    expect(result).toEqual([1, 2]);
  });

  test("pinned message at end — all normal splits valid", () => {
    const pinned: InboundMessage = {
      content: [{ kind: "text", text: "harness context" }],
      senderId: "harness",
      timestamp: 1,
      pinned: true,
    };
    const msgs = [userMsg("a"), userMsg("b"), userMsg("c"), pinned];
    // First pinned at index 3 → cap = 3, preserveRecent=1 → maxSplit = 3
    // effectiveMax = min(3, 3) = 3 → splits at 1, 2, 3
    const result = findValidSplitPoints(msgs, 1);
    expect(result).toEqual([1, 2, 3]);
  });

  test("multiple pinned messages — caps at the first one", () => {
    const pin1: InboundMessage = {
      content: [{ kind: "text", text: "ctx 1" }],
      senderId: "harness",
      timestamp: 1,
      pinned: true,
    };
    const pin2: InboundMessage = {
      content: [{ kind: "text", text: "ctx 2" }],
      senderId: "harness",
      timestamp: 2,
      pinned: true,
    };
    const msgs = [userMsg("old"), pin1, userMsg("mid"), pin2, userMsg("recent")];
    // First pinned at index 1 → cap = 1 → only split at 1
    const result = findValidSplitPoints(msgs, 1);
    expect(result).toEqual([1]);
  });

  test("no pinned messages — normal behavior unchanged", () => {
    const msgs = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];
    const result = findValidSplitPoints(msgs, 1);
    expect(result).toEqual([1, 2, 3]);
  });

  test("pinned message combined with atomic pair", () => {
    const pinned: InboundMessage = {
      content: [{ kind: "text", text: "harness context" }],
      senderId: "harness",
      timestamp: 1,
      pinned: true,
    };
    const msgs = [
      userMsg("old"),
      assistantMsg("calling", "c1"),
      toolResultMsg("c1", "result"),
      pinned,
      userMsg("recent"),
    ];
    // Pair: [1,2] are atomic. Pinned at index 3 → cap = 3.
    // preserveRecent=1 → maxSplit = 4. effectiveMax = min(4, 3) = 3.
    // Split 1: valid (before pair). Split 2: forbidden (interior). Split 3: valid.
    const result = findValidSplitPoints(msgs, 1);
    expect(result).toEqual([1, 3]);
  });
});
