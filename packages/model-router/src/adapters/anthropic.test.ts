import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@koi/core";
import { fromAnthropicResponse, mapAnthropicError, toAnthropicRequest } from "./anthropic.js";

describe("toAnthropicRequest", () => {
  test("transforms basic ModelRequest to Anthropic format", () => {
    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "Hello" }],
          senderId: "test-user",
          timestamp: 0,
        },
      ],
      model: "claude-sonnet-4-5-20250929",
    };

    const result = toAnthropicRequest(request);

    expect(result.model).toBe("claude-sonnet-4-5-20250929");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content).toBe("Hello");
    expect(result.max_tokens).toBe(4096); // default
  });

  test("includes temperature when provided", () => {
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "test" }], senderId: "test-user", timestamp: 0 },
      ],
      temperature: 0.5,
    };

    const result = toAnthropicRequest(request);
    expect(result.temperature).toBe(0.5);
  });

  test("includes maxTokens when provided", () => {
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "test" }], senderId: "test-user", timestamp: 0 },
      ],
      maxTokens: 2000,
    };

    const result = toAnthropicRequest(request);
    expect(result.max_tokens).toBe(2000);
  });

  test("defaults model to claude-sonnet-4-5-20250929 when not specified", () => {
    const request: ModelRequest = {
      messages: [
        { content: [{ kind: "text" as const, text: "test" }], senderId: "test-user", timestamp: 0 },
      ],
    };

    const result = toAnthropicRequest(request);
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
  });

  test("transforms multiple messages", () => {
    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "First" }],
          senderId: "test-user",
          timestamp: 0,
        },
        {
          content: [{ kind: "text" as const, text: "Second" }],
          senderId: "test-user",
          timestamp: 0,
        },
      ],
    };

    const result = toAnthropicRequest(request);
    expect(result.messages).toHaveLength(2);
  });
});

describe("fromAnthropicResponse", () => {
  test("extracts content from text blocks", () => {
    const response = {
      id: "msg_123",
      model: "claude-sonnet-4-5-20250929",
      content: [{ type: "text" as const, text: "Hello from Claude!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 15, output_tokens: 8 },
    };

    const result = fromAnthropicResponse(response);

    expect(result.content).toBe("Hello from Claude!");
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
    expect(result.usage?.inputTokens).toBe(15);
    expect(result.usage?.outputTokens).toBe(8);
  });

  test("joins multiple text blocks", () => {
    const response = {
      id: "msg_123",
      model: "claude-sonnet-4-5-20250929",
      content: [
        { type: "text" as const, text: "Part 1. " },
        { type: "text" as const, text: "Part 2." },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const result = fromAnthropicResponse(response);
    expect(result.content).toBe("Part 1. Part 2.");
  });

  test("handles empty content array", () => {
    const response = {
      id: "msg_123",
      model: "claude-sonnet-4-5-20250929",
      content: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 0 },
    };

    const result = fromAnthropicResponse(response);
    expect(result.content).toBe("");
  });
});

describe("mapAnthropicError", () => {
  test("401 → PERMISSION", () => {
    expect(mapAnthropicError(401)).toBe("PERMISSION");
  });

  test("404 → NOT_FOUND", () => {
    expect(mapAnthropicError(404)).toBe("NOT_FOUND");
  });

  test("429 → RATE_LIMIT", () => {
    expect(mapAnthropicError(429)).toBe("RATE_LIMIT");
  });

  test("529 (overloaded) → RATE_LIMIT", () => {
    expect(mapAnthropicError(529)).toBe("RATE_LIMIT");
  });

  test("rate_limit_error type → RATE_LIMIT", () => {
    expect(mapAnthropicError(400, "rate_limit_error")).toBe("RATE_LIMIT");
  });

  test("overloaded_error type → RATE_LIMIT", () => {
    expect(mapAnthropicError(400, "overloaded_error")).toBe("RATE_LIMIT");
  });

  test("408 → TIMEOUT", () => {
    expect(mapAnthropicError(408)).toBe("TIMEOUT");
  });

  test("504 → TIMEOUT", () => {
    expect(mapAnthropicError(504)).toBe("TIMEOUT");
  });

  test("500 → EXTERNAL", () => {
    expect(mapAnthropicError(500)).toBe("EXTERNAL");
  });

  test("502 → EXTERNAL", () => {
    expect(mapAnthropicError(502)).toBe("EXTERNAL");
  });

  test("400 without special type → EXTERNAL", () => {
    expect(mapAnthropicError(400)).toBe("EXTERNAL");
  });
});
