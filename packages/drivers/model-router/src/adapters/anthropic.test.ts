import { describe, expect, test } from "bun:test";
import type { JsonObject, ModelRequest } from "@koi/core";
import type { CacheHints } from "@koi/execution-context";
import { fromAnthropicResponse, mapAnthropicError, toAnthropicRequest } from "./anthropic.js";

/** Helper: build a request with cache hints embedded in metadata (survives cloning). */
function withCacheHints(request: ModelRequest, hints: CacheHints): ModelRequest {
  return {
    ...request,
    metadata: { ...request.metadata, __koi_cache_hints__: hints as unknown as JsonObject },
  };
}

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

  test("preserves assistant role from senderId", () => {
    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "Hello" }],
          senderId: "user",
          timestamp: 0,
        },
        {
          content: [{ kind: "text" as const, text: "Hi there!" }],
          senderId: "assistant",
          timestamp: 1,
        },
        {
          content: [{ kind: "text" as const, text: "Follow up" }],
          senderId: "user",
          timestamp: 2,
        },
      ],
    };

    const result = toAnthropicRequest(request);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[1]?.role).toBe("assistant");
    expect(result.messages[2]?.role).toBe("user");
  });

  test("extracts system messages to top-level system parameter", () => {
    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "You are helpful." }],
          senderId: "system",
          timestamp: 0,
        },
        {
          content: [{ kind: "text" as const, text: "Hello" }],
          senderId: "user",
          timestamp: 1,
        },
      ],
    };

    const result = toAnthropicRequest(request);
    expect(result.system).toBe("You are helpful.");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content).toBe("Hello");
  });

  test("joins multiple system messages with double newline", () => {
    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "System prompt 1" }],
          senderId: "system",
          timestamp: 0,
        },
        {
          content: [{ kind: "text" as const, text: "Capabilities info" }],
          senderId: "system:capabilities",
          timestamp: 0,
        },
        {
          content: [{ kind: "text" as const, text: "Hello" }],
          senderId: "user",
          timestamp: 1,
        },
      ],
    };

    const result = toAnthropicRequest(request);
    expect(result.system).toBe("System prompt 1\n\nCapabilities info");
    expect(result.messages).toHaveLength(1);
  });

  test("omits system parameter when no system messages present", () => {
    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "Hello" }],
          senderId: "user",
          timestamp: 0,
        },
      ],
    };

    const result = toAnthropicRequest(request);
    expect(result.system).toBeUndefined();
  });

  test("preserves image blocks as structured content with URL source", () => {
    const request: ModelRequest = {
      messages: [
        {
          content: [
            { kind: "text" as const, text: "What is this?" },
            { kind: "image" as const, url: "https://example.com/cat.png" },
          ],
          senderId: "user",
          timestamp: 0,
        },
      ],
    };

    const result = toAnthropicRequest(request);
    const content = result.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({ type: "text", text: "What is this?" });
      expect(content[1]).toEqual({
        type: "image",
        source: { type: "url", url: "https://example.com/cat.png" },
      });
    }
  });

  test("converts base64 data URL images to base64 source format", () => {
    const request: ModelRequest = {
      messages: [
        {
          content: [
            {
              kind: "image" as const,
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
            },
          ],
          senderId: "user",
          timestamp: 0,
        },
      ],
    };

    const result = toAnthropicRequest(request);
    const content = result.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      expect(content[0]).toEqual({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUg==",
        },
      });
    }
  });

  test("applies cache_control to system when anthropic cache hints present", () => {
    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "You are helpful." }],
          senderId: "system",
          timestamp: 0,
        },
        {
          content: [{ kind: "text" as const, text: "Hello" }],
          senderId: "user",
          timestamp: 1,
        },
      ],
      model: "anthropic:claude-sonnet-4-5-20250929",
    };

    const withHints = withCacheHints(request, {
      provider: "anthropic",
      lastStableIndex: 0,
      staticPrefixTokens: 2000,
    });

    const result = toAnthropicRequest(withHints);
    expect(Array.isArray(result.system)).toBe(true);
    if (Array.isArray(result.system)) {
      expect(result.system).toHaveLength(1);
      expect(result.system[0]?.type).toBe("text");
      expect(result.system[0]?.text).toBe("You are helpful.");
      expect(result.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    }
  });

  test("applies cache_control regardless of provider hint value", () => {
    // The Anthropic adapter always applies cache_control when hints exist,
    // regardless of hints.provider — the adapter already knows it's Anthropic.
    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "You are helpful." }],
          senderId: "system",
          timestamp: 0,
        },
        {
          content: [{ kind: "text" as const, text: "Hello" }],
          senderId: "user",
          timestamp: 1,
        },
      ],
    };

    const withHints = withCacheHints(request, {
      provider: "unknown",
      lastStableIndex: 0,
      staticPrefixTokens: 2000,
    });

    const result = toAnthropicRequest(withHints);
    expect(Array.isArray(result.system)).toBe(true);
  });

  test("no cache_control when no hints are attached", () => {
    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "You are helpful." }],
          senderId: "system",
          timestamp: 0,
        },
        {
          content: [{ kind: "text" as const, text: "Hello" }],
          senderId: "user",
          timestamp: 1,
        },
      ],
    };

    const result = toAnthropicRequest(request);
    expect(typeof result.system).toBe("string");
  });

  test("returns plain string for text-only content", () => {
    const request: ModelRequest = {
      messages: [
        {
          content: [
            { kind: "text" as const, text: "Part 1" },
            { kind: "text" as const, text: " Part 2" },
          ],
          senderId: "user",
          timestamp: 0,
        },
      ],
    };

    const result = toAnthropicRequest(request);
    expect(result.messages[0]?.content).toBe("Part 1 Part 2");
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
