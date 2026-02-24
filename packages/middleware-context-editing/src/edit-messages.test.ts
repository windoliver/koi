import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core/message";
import { editMessages } from "./edit-messages.js";
import { heuristicTokenEstimator } from "./estimator.js";
import type { ResolvedContextEditingConfig } from "./types.js";

/** Helper to create a resolved config with overrides. */
function makeConfig(
  overrides?: Partial<ResolvedContextEditingConfig>,
): ResolvedContextEditingConfig {
  return {
    triggerTokenCount: 100,
    numRecentToKeep: 1,
    clearToolCallInputs: false,
    excludeTools: new Set<string>(),
    placeholder: "[cleared]",
    tokenEstimator: heuristicTokenEstimator,
    ...overrides,
  };
}

/** Helper to create a tool result message. */
function toolMsg(
  toolName: string,
  text: string,
  extra?: {
    readonly callId?: string;
    readonly timestamp?: number;
  },
): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "tool",
    timestamp: extra?.timestamp ?? Date.now(),
    metadata: {
      toolName,
      ...(extra?.callId !== undefined ? { callId: extra.callId } : {}),
    },
  };
}

/** Helper to create a user message. */
function userMsg(text: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "user",
    timestamp: Date.now(),
  };
}

/** Helper to create an assistant message with a callId in metadata. */
function assistantMsg(text: string, callId?: string): InboundMessage {
  const base = {
    content: [{ kind: "text" as const, text }],
    senderId: "assistant",
    timestamp: Date.now(),
  };
  if (callId !== undefined) {
    return { ...base, metadata: { callId } };
  }
  return base;
}

describe("editMessages", () => {
  test("returns same array reference when below threshold", () => {
    const messages: readonly InboundMessage[] = [
      userMsg("hello"),
      toolMsg("search", "result data"),
    ];
    const config = makeConfig({ triggerTokenCount: 999_999 });
    const result = editMessages(messages, 100, config);
    expect(result).toBe(messages);
  });

  test("clears oldest tool results, preserves last N", () => {
    const messages: readonly InboundMessage[] = [
      userMsg("q1"),
      toolMsg("search", "old result 1"),
      userMsg("q2"),
      toolMsg("search", "old result 2"),
      userMsg("q3"),
      toolMsg("search", "recent result"),
    ];
    const config = makeConfig({ numRecentToKeep: 1 });
    const result = editMessages(messages, 200, config);
    // Indices 1 and 3 should be cleared, index 5 preserved
    expect(result[1]?.content).toEqual([{ kind: "text", text: "[cleared]" }]);
    expect(result[3]?.content).toEqual([{ kind: "text", text: "[cleared]" }]);
    expect(result[5]?.content).toEqual([{ kind: "text", text: "recent result" }]);
  });

  test("respects excludeTools — excluded tools never cleared", () => {
    const messages: readonly InboundMessage[] = [
      toolMsg("memory", "important context"),
      toolMsg("search", "old search result"),
      toolMsg("search", "recent search result"),
    ];
    const config = makeConfig({
      numRecentToKeep: 1,
      excludeTools: new Set(["memory"]),
    });
    const result = editMessages(messages, 200, config);
    // memory (index 0) is excluded, search at index 1 cleared, index 2 kept (recent)
    expect(result[0]?.content).toEqual([{ kind: "text", text: "important context" }]);
    expect(result[1]?.content).toEqual([{ kind: "text", text: "[cleared]" }]);
    expect(result[2]?.content).toEqual([{ kind: "text", text: "recent search result" }]);
  });

  test("keep and exclude overlap — both protections apply independently", () => {
    // 3 tool results: 1 excluded, 2 non-excluded with numRecentToKeep=2
    const messages: readonly InboundMessage[] = [
      toolMsg("memory", "ctx"),
      toolMsg("search", "res1"),
      toolMsg("search", "res2"),
    ];
    const config = makeConfig({
      numRecentToKeep: 2,
      excludeTools: new Set(["memory"]),
    });
    const result = editMessages(messages, 200, config);
    // memory excluded, both search results are in last 2 non-excluded => nothing cleared
    expect(result).toBe(messages);
  });

  test("all results excluded — nothing cleared", () => {
    const messages: readonly InboundMessage[] = [
      toolMsg("memory", "ctx1"),
      toolMsg("memory", "ctx2"),
    ];
    const config = makeConfig({
      numRecentToKeep: 0,
      excludeTools: new Set(["memory"]),
    });
    const result = editMessages(messages, 200, config);
    expect(result).toBe(messages);
  });

  test("numRecentToKeep greater than total results — nothing cleared", () => {
    const messages: readonly InboundMessage[] = [
      toolMsg("search", "res1"),
      toolMsg("search", "res2"),
    ];
    const config = makeConfig({ numRecentToKeep: 5 });
    const result = editMessages(messages, 200, config);
    expect(result).toBe(messages);
  });

  test("original messages array and objects are not mutated", () => {
    const original: readonly InboundMessage[] = [
      toolMsg("search", "old result"),
      toolMsg("search", "recent result"),
    ];
    // Deep clone to compare later
    const snapshot = JSON.parse(JSON.stringify(original));
    const config = makeConfig({ numRecentToKeep: 1 });
    const result = editMessages(original, 200, config);
    // Result is a new array
    expect(result).not.toBe(original);
    // Original unchanged
    expect(JSON.stringify(original)).toBe(JSON.stringify(snapshot));
  });

  test("clearToolCallInputs clears corresponding assistant message", () => {
    const messages: readonly InboundMessage[] = [
      userMsg("question"),
      assistantMsg("calling tool", "call-1"),
      toolMsg("search", "old result", { callId: "call-1" }),
      assistantMsg("calling tool", "call-2"),
      toolMsg("search", "recent result", { callId: "call-2" }),
    ];
    const config = makeConfig({
      numRecentToKeep: 1,
      clearToolCallInputs: true,
    });
    const result = editMessages(messages, 200, config);
    // Tool result at index 2 cleared, assistant at index 1 also cleared
    expect(result[1]?.content).toEqual([{ kind: "text", text: "[cleared]" }]);
    expect(result[2]?.content).toEqual([{ kind: "text", text: "[cleared]" }]);
    // Recent ones preserved
    expect(result[3]?.content).toEqual([{ kind: "text", text: "calling tool" }]);
    expect(result[4]?.content).toEqual([{ kind: "text", text: "recent result" }]);
  });

  test("returns same reference for empty messages", () => {
    const messages: readonly InboundMessage[] = [];
    const config = makeConfig();
    const result = editMessages(messages, 200, config);
    expect(result).toBe(messages);
  });

  test("returns same reference when no tool results in messages", () => {
    const messages: readonly InboundMessage[] = [userMsg("hello"), assistantMsg("hi there")];
    const config = makeConfig();
    const result = editMessages(messages, 200, config);
    expect(result).toBe(messages);
  });

  test("uses custom placeholder text", () => {
    const messages: readonly InboundMessage[] = [
      toolMsg("search", "old result"),
      toolMsg("search", "recent result"),
    ];
    const config = makeConfig({
      numRecentToKeep: 1,
      placeholder: "<redacted>",
    });
    const result = editMessages(messages, 200, config);
    expect(result[0]?.content).toEqual([{ kind: "text", text: "<redacted>" }]);
  });

  test("preserves metadata on cleared messages", () => {
    const messages: readonly InboundMessage[] = [
      toolMsg("search", "old result", { callId: "c1" }),
      toolMsg("search", "recent"),
    ];
    const config = makeConfig({ numRecentToKeep: 1 });
    const result = editMessages(messages, 200, config);
    // Content is replaced but metadata is preserved
    expect(result[0]?.content).toEqual([{ kind: "text", text: "[cleared]" }]);
    expect(result[0]?.metadata?.toolName).toBe("search");
    expect(result[0]?.metadata?.callId).toBe("c1");
    expect(result[0]?.senderId).toBe("tool");
  });
});
