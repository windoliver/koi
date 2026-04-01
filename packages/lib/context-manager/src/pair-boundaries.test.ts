/**
 * Pair boundary detection tests (ported from v1 with additions).
 */

import { describe, expect, it } from "bun:test";
import type { InboundMessage } from "@koi/core";
import { findValidSplitPoints, rescuePinnedGroups } from "./pair-boundaries.js";

function msg(sender: string, callId?: string, pinned?: boolean): InboundMessage {
  return {
    content: [{ kind: "text", text: "content" }],
    senderId: sender,
    timestamp: Date.now(),
    ...(callId !== undefined ? { metadata: { callId } } : {}),
    ...(pinned !== undefined ? { pinned } : {}),
  };
}

function assistantWithToolUse(callId: string, pinned?: boolean): InboundMessage {
  return {
    content: [{ kind: "custom", type: "tool_use", data: { id: callId, name: "test" } }],
    senderId: "assistant",
    timestamp: Date.now(),
    metadata: { callId },
    ...(pinned !== undefined ? { pinned } : {}),
  };
}

describe("findValidSplitPoints", () => {
  it("returns empty for too few messages to split", () => {
    const messages = [msg("user"), msg("assistant"), msg("user")];
    expect(findValidSplitPoints(messages, 4)).toEqual([]);
  });

  it("returns all valid indices for simple messages", () => {
    const messages = [msg("user"), msg("assistant"), msg("user"), msg("assistant"), msg("user")];
    expect(findValidSplitPoints(messages, 2)).toEqual([1, 2, 3]);
  });

  it("skips interior of assistant+tool pairs", () => {
    const messages = [
      assistantWithToolUse("call_1"),
      msg("tool", "call_1"),
      msg("user"),
      msg("assistant"),
      msg("user"),
    ];
    expect(findValidSplitPoints(messages, 2)).toEqual([2, 3]);
  });

  it("allows splits past pinned messages", () => {
    const messages = [
      msg("user"),
      msg("user", undefined, true),
      msg("assistant"),
      msg("user"),
      msg("assistant"),
    ];
    expect(findValidSplitPoints(messages, 2)).toEqual([1, 2, 3]);
  });

  it("allows compaction even with pinned message at index 0", () => {
    const messages = [
      msg("system", undefined, true),
      msg("user"),
      msg("assistant"),
      msg("user"),
      msg("assistant"),
    ];
    const result = findValidSplitPoints(messages, 2);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toEqual([1, 2, 3]);
  });

  it("returns empty when all messages are within preserveRecent", () => {
    expect(findValidSplitPoints([msg("user"), msg("assistant")], 2)).toEqual([]);
  });

  it("handles preserveRecent = 0", () => {
    const messages = [msg("user"), msg("assistant"), msg("user")];
    expect(findValidSplitPoints(messages, 0)).toEqual([1, 2, 3]);
  });

  it("handles multiple pairs", () => {
    const messages = [
      assistantWithToolUse("c1"),
      msg("tool", "c1"),
      assistantWithToolUse("c2"),
      msg("tool", "c2"),
      msg("user"),
    ];
    expect(findValidSplitPoints(messages, 1)).toEqual([2, 4]);
  });

  it("handles single message", () => {
    expect(findValidSplitPoints([msg("user")], 1)).toEqual([]);
  });

  it("protects all pairs with duplicate callIds", () => {
    const messages = [
      assistantWithToolUse("c1"),
      msg("tool", "c1"),
      assistantWithToolUse("c1"),
      msg("tool", "c1"),
      msg("user"),
    ];
    const result = findValidSplitPoints(messages, 1);
    expect(result).not.toContain(1);
    expect(result).not.toContain(3);
    expect(result).toContain(2);
    expect(result).toContain(4);
  });

  it("protects interleaved pairs with duplicate callIds", () => {
    const messages = [
      assistantWithToolUse("c1"),
      assistantWithToolUse("c1"),
      msg("tool", "c1"),
      msg("tool", "c1"),
      msg("user"),
    ];
    const result = findValidSplitPoints(messages, 1);
    expect(result).toEqual([4]);
  });
});

describe("rescuePinnedGroups", () => {
  it("returns empty when no pinned in head", () => {
    const messages = [msg("user"), msg("assistant"), msg("user")];
    expect(rescuePinnedGroups(messages, 2)).toEqual([]);
  });

  it("rescues pinned messages from head", () => {
    const messages = [msg("system", undefined, true), msg("user"), msg("assistant"), msg("user")];
    const rescued = rescuePinnedGroups(messages, 2);
    expect(rescued.length).toBe(1);
    expect(rescued[0]).toBe(messages[0]);
  });

  it("rescues entire pair when pinned tool result is in head", () => {
    // [assistant(c1), tool(c1, pinned), user, assistant]
    // Split at 2: head = [asst(c1), tool(c1, pinned)]
    // Pinned tool at index 1 → rescue its pair partner (asst at 0) too
    const messages = [
      assistantWithToolUse("c1"),
      msg("tool", "c1", true), // pinned tool result
      msg("user"),
      msg("assistant"),
    ];
    const rescued = rescuePinnedGroups(messages, 2);
    // Both the assistant and the pinned tool result are rescued
    expect(rescued.length).toBe(2);
    expect(rescued[0]).toBe(messages[0]); // assistant
    expect(rescued[1]).toBe(messages[1]); // pinned tool
  });

  it("rescues entire pair when pinned assistant is in head", () => {
    // [assistant(c1, pinned), tool(c1), user, assistant]
    const messages = [
      assistantWithToolUse("c1", true), // pinned assistant
      msg("tool", "c1"),
      msg("user"),
      msg("assistant"),
    ];
    const rescued = rescuePinnedGroups(messages, 2);
    expect(rescued.length).toBe(2);
    expect(rescued[0]).toBe(messages[0]); // pinned assistant
    expect(rescued[1]).toBe(messages[1]); // tool result (pair partner)
  });

  it("does not rescue tail-side pair partners", () => {
    // [assistant(c1, pinned), user, tool(c1), user]
    // Split at 2: head = [asst(c1, pinned), user]
    // tool(c1) is in the tail — already preserved, don't rescue
    const messages = [
      assistantWithToolUse("c1", true),
      msg("user"),
      msg("tool", "c1"),
      msg("user"),
    ];
    const rescued = rescuePinnedGroups(messages, 2);
    // Only the pinned assistant and the user between are rescued
    // (user at 1 is in the group range 0..2 but tool is at 2 which is in tail)
    expect(rescued.length).toBe(1); // just the pinned assistant
    expect(rescued[0]).toBe(messages[0]);
  });

  it("rescues multiple pinned messages and their groups", () => {
    // [pinned_system, assistant(c1), tool(c1, pinned), user, assistant]
    const messages = [
      msg("system", undefined, true),
      assistantWithToolUse("c1"),
      msg("tool", "c1", true),
      msg("user"),
      msg("assistant"),
    ];
    const rescued = rescuePinnedGroups(messages, 3);
    // pinned system at 0, pinned tool at 2 + its pair partner (asst at 1)
    expect(rescued.length).toBe(3);
    expect(rescued[0]).toBe(messages[0]); // pinned system
    expect(rescued[1]).toBe(messages[1]); // asst (pair partner)
    expect(rescued[2]).toBe(messages[2]); // pinned tool
  });

  it("returns rescued in original order", () => {
    const messages = [
      msg("user"),
      msg("system", undefined, true), // pinned at 1
      msg("system", undefined, true), // pinned at 2
      msg("user"),
    ];
    const rescued = rescuePinnedGroups(messages, 3);
    expect(rescued.length).toBe(2);
    expect(rescued[0]).toBe(messages[1]);
    expect(rescued[1]).toBe(messages[2]);
  });
});
