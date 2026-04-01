import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { fromAnthropicMessage } from "../map-response.js";

describe("fromAnthropicMessage", () => {
  test("extracts text content from response", () => {
    const msg: Anthropic.Message = {
      id: "msg_123",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [{ type: "text", text: "Hello!", citations: null }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    };

    const result = fromAnthropicMessage(msg);
    expect(result.content).toBe("Hello!");
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  test("joins multiple text blocks", () => {
    const msg: Anthropic.Message = {
      id: "msg_456",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [
        { type: "text", text: "Part 1 ", citations: null },
        { type: "text", text: "Part 2", citations: null },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 20,
        output_tokens: 10,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    };

    const result = fromAnthropicMessage(msg);
    expect(result.content).toBe("Part 1 Part 2");
  });

  test("filters out non-text blocks (tool_use)", () => {
    const msg: Anthropic.Message = {
      id: "msg_789",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [
        { type: "text", text: "Let me help.", citations: null },
        { type: "tool_use", id: "call_1", name: "read_file", input: { path: "/tmp" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 15,
        output_tokens: 8,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    };

    const result = fromAnthropicMessage(msg);
    expect(result.content).toBe("Let me help.");
  });

  test("returns empty string when no text blocks", () => {
    const msg: Anthropic.Message = {
      id: "msg_empty",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [{ type: "tool_use", id: "call_1", name: "search", input: {} }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 5,
        output_tokens: 3,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    };

    const result = fromAnthropicMessage(msg);
    expect(result.content).toBe("");
  });
});
