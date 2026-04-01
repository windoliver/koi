import { describe, expect, test } from "bun:test";
import { threadMessageId } from "@koi/core";
import { mapThreadMessageToInbound } from "./map-thread-to-inbound.js";

describe("mapThreadMessageToInbound", () => {
  const baseMsg = {
    id: threadMessageId("m1"),
    role: "user" as const,
    content: "hello",
    createdAt: 1000,
  };

  test("maps user message with correct senderId", () => {
    const result = mapThreadMessageToInbound(baseMsg, "agent-1", "user-42");

    expect(result.senderId).toBe("user-42");
    expect(result.content).toEqual([{ kind: "text", text: "hello" }]);
    expect(result.timestamp).toBe(1000);
  });

  test("maps user message falls back to 'user' when no userId", () => {
    const result = mapThreadMessageToInbound(baseMsg, "agent-1");

    expect(result.senderId).toBe("user");
  });

  test("maps assistant message with agentId as senderId", () => {
    const msg = { ...baseMsg, role: "assistant" as const, content: "hi back" };
    const result = mapThreadMessageToInbound(msg, "agent-1", "user-42");

    expect(result.senderId).toBe("agent-1");
    expect(result.content).toEqual([{ kind: "text", text: "hi back" }]);
  });

  test("maps system message with 'system' senderId", () => {
    const msg = { ...baseMsg, role: "system" as const, content: "system prompt" };
    const result = mapThreadMessageToInbound(msg, "agent-1");

    expect(result.senderId).toBe("system");
  });

  test("maps tool message with 'tool' senderId", () => {
    const msg = { ...baseMsg, role: "tool" as const, content: "tool output" };
    const result = mapThreadMessageToInbound(msg, "agent-1");

    expect(result.senderId).toBe("tool");
  });

  test("wraps content in TextBlock", () => {
    const result = mapThreadMessageToInbound(baseMsg, "agent-1");

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ kind: "text", text: "hello" });
  });

  test("sets fromHistory: true in metadata", () => {
    const result = mapThreadMessageToInbound(baseMsg, "agent-1");

    expect(result.metadata).toBeDefined();
    expect(result.metadata?.fromHistory).toBe(true);
  });

  test("preserves existing metadata and adds fromHistory", () => {
    const msg = { ...baseMsg, metadata: { custom: "value" } };
    const result = mapThreadMessageToInbound(msg, "agent-1");

    expect(result.metadata).toEqual({
      custom: "value",
      fromHistory: true,
      originalRole: "user",
      agentId: "agent-1",
    });
  });

  test("preserves timestamp from createdAt", () => {
    const msg = { ...baseMsg, createdAt: 9999 };
    const result = mapThreadMessageToInbound(msg, "agent-1");

    expect(result.timestamp).toBe(9999);
  });
});
