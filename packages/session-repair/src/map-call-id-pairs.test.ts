import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core/message";
import { mapCallIdPairs } from "./map-call-id-pairs.js";

function msg(senderId: string, callId?: string, ts = 0): InboundMessage {
  return {
    senderId,
    content: [{ kind: "text", text: "test" }],
    timestamp: ts,
    ...(callId !== undefined ? { metadata: { callId } } : {}),
  };
}

describe("mapCallIdPairs", () => {
  test("returns empty maps for empty array", () => {
    const result = mapCallIdPairs([]);
    expect(result.assistantByCallId.size).toBe(0);
    expect(result.orphanToolIndices).toEqual([]);
    expect(result.danglingToolUseIndices).toEqual([]);
  });

  test("maps matched assistant+tool pairs", () => {
    const messages = [msg("assistant", "c1"), msg("tool", "c1")];
    const result = mapCallIdPairs(messages);
    expect(result.assistantByCallId.get("c1")).toBe(0);
    expect(result.orphanToolIndices).toEqual([]);
    expect(result.danglingToolUseIndices).toEqual([]);
  });

  test("detects orphan tool results", () => {
    const messages = [msg("user"), msg("tool", "c1")];
    const result = mapCallIdPairs(messages);
    expect(result.orphanToolIndices).toEqual([1]);
  });

  test("detects dangling tool_use", () => {
    const messages = [msg("assistant", "c1"), msg("user")];
    const result = mapCallIdPairs(messages);
    expect(result.danglingToolUseIndices).toEqual([0]);
  });

  test("handles multiple callIds", () => {
    const messages = [
      msg("assistant", "c1"),
      msg("tool", "c1"),
      msg("assistant", "c2"),
      msg("tool", "c2"),
    ];
    const result = mapCallIdPairs(messages);
    expect(result.assistantByCallId.size).toBe(2);
    expect(result.orphanToolIndices).toEqual([]);
    expect(result.danglingToolUseIndices).toEqual([]);
  });

  test("handles mixed orphans and matched pairs", () => {
    const messages = [
      msg("assistant", "c1"),
      msg("tool", "c1"),
      msg("tool", "c2"), // orphan
      msg("assistant", "c3"), // dangling
    ];
    const result = mapCallIdPairs(messages);
    expect(result.orphanToolIndices).toEqual([2]);
    expect(result.danglingToolUseIndices).toEqual([3]);
  });

  test("ignores messages without callId", () => {
    const messages = [msg("assistant"), msg("tool"), msg("user")];
    const result = mapCallIdPairs(messages);
    expect(result.assistantByCallId.size).toBe(0);
    expect(result.orphanToolIndices).toEqual([]);
    expect(result.danglingToolUseIndices).toEqual([]);
  });

  test("ignores non-string callId metadata", () => {
    const messages: readonly InboundMessage[] = [
      {
        senderId: "assistant",
        content: [{ kind: "text", text: "test" }],
        timestamp: 0,
        metadata: { callId: 123 },
      },
    ];
    const result = mapCallIdPairs(messages);
    expect(result.assistantByCallId.size).toBe(0);
  });

  test("returns dangling indices in sorted order", () => {
    const messages = [
      msg("assistant", "c3"),
      msg("user"),
      msg("assistant", "c1"),
      msg("user"),
      msg("assistant", "c2"),
    ];
    const result = mapCallIdPairs(messages);
    expect(result.danglingToolUseIndices).toEqual([0, 2, 4]);
  });
});
