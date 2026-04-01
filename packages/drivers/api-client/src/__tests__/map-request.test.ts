import { describe, expect, test } from "bun:test";
import type { InboundMessage, ModelRequest } from "@koi/core";
import { toAnthropicParams, toAnthropicStreamParams } from "../map-request.js";

const ts = Date.now();
const defaults = { model: "claude-sonnet-4-5-20250929", maxTokens: 4096 };

function userMsg(text: string): InboundMessage {
  return { content: [{ kind: "text", text }], senderId: "user-1", timestamp: ts };
}

describe("toAnthropicParams", () => {
  test("uses defaults when request fields are omitted", () => {
    const request: ModelRequest = { messages: [userMsg("Hello")] };
    const result = toAnthropicParams(request, defaults);

    expect(result.model).toBe("claude-sonnet-4-5-20250929");
    expect(result.max_tokens).toBe(4096);
    expect(result.messages).toHaveLength(1);
  });

  test("overrides model and maxTokens from request", () => {
    const request: ModelRequest = {
      messages: [userMsg("Hi")],
      model: "claude-haiku-3-5-20241022",
      maxTokens: 1024,
    };
    const result = toAnthropicParams(request, defaults);

    expect(result.model).toBe("claude-haiku-3-5-20241022");
    expect(result.max_tokens).toBe(1024);
  });

  test("includes temperature when provided", () => {
    const request: ModelRequest = {
      messages: [userMsg("Hi")],
      temperature: 0.7,
    };
    const result = toAnthropicParams(request, defaults);
    expect(result.temperature).toBe(0.7);
  });

  test("omits temperature when not provided", () => {
    const request: ModelRequest = { messages: [userMsg("Hi")] };
    const result = toAnthropicParams(request, defaults);
    expect("temperature" in result).toBe(false);
  });

  test("includes system prompt from system messages", () => {
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text", text: "Be helpful" }], senderId: "system", timestamp: ts },
        userMsg("Hi"),
      ],
    };
    const result = toAnthropicParams(request, defaults);
    expect(result.system).toBe("Be helpful");
  });

  test("includes tools when provided", () => {
    const request: ModelRequest = {
      messages: [userMsg("Hi")],
      tools: [{ name: "read", description: "Read file", inputSchema: { type: "object" } }],
    };
    const result = toAnthropicParams(request, defaults);
    expect(result.tools).toHaveLength(1);
    expect(result.tools?.[0]?.name).toBe("read");
  });

  test("omits tools when empty array", () => {
    const request: ModelRequest = { messages: [userMsg("Hi")], tools: [] };
    const result = toAnthropicParams(request, defaults);
    expect("tools" in result).toBe(false);
  });
});

describe("toAnthropicStreamParams", () => {
  test("adds stream: true", () => {
    const request: ModelRequest = { messages: [userMsg("Hi")] };
    const result = toAnthropicStreamParams(request, defaults);
    expect(result.stream).toBe(true);
  });
});
