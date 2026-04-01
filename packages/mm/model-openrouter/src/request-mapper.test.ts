/**
 * Request mapper tests — ModelRequest → OpenAI Chat Completions body.
 */

import { describe, expect, test } from "bun:test";
import type { InboundMessage, ModelRequest } from "@koi/core";
import { buildRequestBody, mapMessages } from "./request-mapper.js";
import type { ResolvedConfig } from "./types.js";
import { DEFAULT_CAPABILITIES } from "./types.js";

const CONFIG: ResolvedConfig = {
  apiKey: "test-key",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "test-model",
  capabilities: DEFAULT_CAPABILITIES,
  headers: {},
  provider: "openrouter",
};

function makeMessage(text: string, senderId = "user-1"): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// mapMessages — role mapping
// ---------------------------------------------------------------------------

describe("mapMessages", () => {
  test("maps user messages with correct role", () => {
    const result = mapMessages([makeMessage("hello"), makeMessage("world")]);
    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe("user");
    expect(result[0]?.content).toBe("hello");
  });

  test("maps assistant messages with role assistant", () => {
    const msg: InboundMessage = {
      content: [{ kind: "text", text: "I can help with that." }],
      senderId: "assistant",
      timestamp: Date.now(),
    };
    const result = mapMessages([msg]);
    expect(result[0]?.role).toBe("assistant");
    expect(result[0]?.content).toBe("I can help with that.");
  });

  test("maps assistant messages with tool_calls from metadata", () => {
    const msg: InboundMessage = {
      content: [],
      senderId: "assistant",
      timestamp: Date.now(),
      metadata: {
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "search", arguments: '{"q":"test"}' },
          },
        ],
      },
    };
    const result = mapMessages([msg]);
    expect(result[0]?.role).toBe("assistant");
    expect(result[0]?.content).toBeNull();
    expect(result[0]?.tool_calls).toHaveLength(1);
  });

  test("maps tool messages with role tool and tool_call_id when preceded by tool_calls", () => {
    const messages: readonly InboundMessage[] = [
      {
        content: [],
        senderId: "assistant",
        timestamp: Date.now(),
        metadata: {
          toolCalls: [
            { id: "call_1", type: "function", function: { name: "search", arguments: "{}" } },
          ],
        },
      },
      {
        content: [{ kind: "text", text: "Search result: found 3 items" }],
        senderId: "tool",
        timestamp: Date.now(),
        metadata: { toolCallId: "call_1" },
      },
    ];
    const result = mapMessages(messages);
    expect(result[1]?.role).toBe("tool");
    expect(result[1]?.content).toBe("Search result: found 3 items");
    expect(result[1]?.tool_call_id).toBe("call_1");
  });

  test("preserves multi-turn conversation role sequence", () => {
    const messages: readonly InboundMessage[] = [
      makeMessage("What's the weather?"),
      {
        content: [],
        senderId: "assistant",
        timestamp: Date.now(),
        metadata: {
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "weather", arguments: '{"city":"SF"}' },
            },
          ],
        },
      },
      {
        content: [{ kind: "text", text: "72°F sunny" }],
        senderId: "tool",
        timestamp: Date.now(),
        metadata: { toolCallId: "c1" },
      },
      {
        content: [{ kind: "text", text: "It's 72°F and sunny in SF." }],
        senderId: "assistant",
        timestamp: Date.now(),
      },
    ];
    const result = mapMessages(messages);
    expect(result.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  // ---------------------------------------------------------------------------
  // session-repair callId convention
  // ---------------------------------------------------------------------------

  test("assistant with only callId omits tool_calls (no fabrication)", () => {
    const msg: InboundMessage = {
      content: [{ kind: "text", text: "calling tool" }],
      senderId: "assistant",
      timestamp: Date.now(),
      metadata: { callId: "c1", synthetic: true },
    };
    const result = mapMessages([msg]);
    expect(result[0]?.role).toBe("assistant");
    // Should NOT fabricate tool_calls from callId alone
    expect(result[0]?.tool_calls).toBeUndefined();
    expect(result[0]?.content).toBe("calling tool");
  });

  test("orphaned tool with callId (no preceding tool_calls) is dropped", () => {
    // Session-repair creates assistant+tool pairs with callId only.
    // Since the assistant has no tool_calls, the tool message is orphaned.
    // Orphaned tool messages are dropped to preserve the trust boundary
    // (tool results must not be relabeled as user input).
    const messages: readonly InboundMessage[] = [
      {
        content: [{ kind: "text", text: "calling tool" }],
        senderId: "assistant",
        timestamp: Date.now(),
        metadata: { callId: "c1" },
      },
      {
        content: [{ kind: "text", text: "tool output" }],
        senderId: "tool",
        timestamp: Date.now(),
        metadata: { callId: "c1" },
      },
    ];
    const result = mapMessages(messages);
    // Only assistant remains — orphaned tool is dropped
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("assistant");
    expect(result[0]?.tool_calls).toBeUndefined();
  });

  test("tool with valid preceding tool_calls keeps tool role", () => {
    const messages: readonly InboundMessage[] = [
      {
        content: [],
        senderId: "assistant",
        timestamp: Date.now(),
        metadata: {
          toolCalls: [
            { id: "c1", type: "function", function: { name: "search", arguments: "{}" } },
          ],
        },
      },
      {
        content: [{ kind: "text", text: "result" }],
        senderId: "tool",
        timestamp: Date.now(),
        metadata: { toolCallId: "c1" },
      },
    ];
    const result = mapMessages(messages);
    expect(result[0]?.role).toBe("assistant");
    expect(result[1]?.role).toBe("tool");
    expect(result[1]?.tool_call_id).toBe("c1");
  });

  // ---------------------------------------------------------------------------
  // metadata.role override
  // ---------------------------------------------------------------------------

  test("metadata.role overrides senderId heuristic", () => {
    const msg: InboundMessage = {
      content: [{ kind: "text", text: "I am the agent" }],
      senderId: "agent-123",
      timestamp: Date.now(),
      metadata: { role: "assistant" },
    };
    const result = mapMessages([msg]);
    expect(result[0]?.role).toBe("assistant");
  });

  test("non-standard senderId without metadata.role defaults to user", () => {
    const msg: InboundMessage = {
      content: [{ kind: "text", text: "hello" }],
      senderId: "agent-456",
      timestamp: Date.now(),
    };
    const result = mapMessages([msg]);
    expect(result[0]?.role).toBe("user");
  });

  // ---------------------------------------------------------------------------
  // Non-text block rejection
  // ---------------------------------------------------------------------------

  test("throws when image content is present", () => {
    const messages: readonly InboundMessage[] = [
      {
        content: [
          { kind: "text", text: "Look: " },
          { kind: "image", url: "https://img.png", alt: "a cat" },
        ],
        senderId: "user-1",
        timestamp: Date.now(),
      },
    ];
    expect(() => mapMessages(messages)).toThrow('"image"');
  });

  test("throws when file content is present", () => {
    const messages: readonly InboundMessage[] = [
      {
        content: [
          { kind: "file", url: "https://f.pdf", mimeType: "application/pdf", name: "doc.pdf" },
        ],
        senderId: "user-1",
        timestamp: Date.now(),
      },
    ];
    expect(() => mapMessages(messages)).toThrow('"file"');
  });

  test("throws when button content is present", () => {
    const messages: readonly InboundMessage[] = [
      {
        content: [{ kind: "button", label: "Click", action: "submit" }],
        senderId: "user-1",
        timestamp: Date.now(),
      },
    ];
    expect(() => mapMessages(messages)).toThrow('"button"');
  });

  test("throws when custom content is present", () => {
    const messages: readonly InboundMessage[] = [
      {
        content: [{ kind: "custom", type: "chart", data: { x: 1 } }],
        senderId: "user-1",
        timestamp: Date.now(),
      },
    ];
    expect(() => mapMessages(messages)).toThrow('"custom"');
  });
});

// ---------------------------------------------------------------------------
// buildRequestBody
// ---------------------------------------------------------------------------

describe("buildRequestBody", () => {
  test("includes model and stream options", () => {
    const request: ModelRequest = {
      messages: [makeMessage("hi")],
    };
    const body = buildRequestBody(request, CONFIG);
    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test("overrides model from request", () => {
    const request: ModelRequest = {
      messages: [makeMessage("hi")],
      model: "override-model",
    };
    const body = buildRequestBody(request, CONFIG);
    expect(body.model).toBe("override-model");
  });

  test("includes temperature when set", () => {
    const request: ModelRequest = {
      messages: [makeMessage("hi")],
      temperature: 0.7,
    };
    const body = buildRequestBody(request, CONFIG);
    expect(body.temperature).toBe(0.7);
  });

  test("includes maxTokens when set", () => {
    const request: ModelRequest = {
      messages: [makeMessage("hi")],
      maxTokens: 1024,
    };
    const body = buildRequestBody(request, CONFIG);
    expect(body.max_tokens).toBe(1024);
  });

  test("includes tools when provided", () => {
    const request: ModelRequest = {
      messages: [makeMessage("hi")],
    };
    const tools = [
      {
        type: "function" as const,
        function: { name: "search", description: "Search", parameters: {} },
      },
    ];
    const body = buildRequestBody(request, CONFIG, tools);
    expect(body.tools).toEqual(tools);
  });

  test("omits tools when empty array", () => {
    const request: ModelRequest = {
      messages: [makeMessage("hi")],
    };
    const body = buildRequestBody(request, CONFIG, []);
    expect(body.tools).toBeUndefined();
  });

  test("includes system prompt from metadata", () => {
    const request: ModelRequest = {
      messages: [makeMessage("hi")],
      metadata: { systemPrompt: "You are helpful." },
    };
    const body = buildRequestBody(request, CONFIG);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toBe("You are helpful.");
  });
});
