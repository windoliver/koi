/**
 * Request mapper tests — ModelRequest → OpenAI Chat Completions body.
 */

import { describe, expect, test } from "bun:test";
import type { InboundMessage, ModelRequest } from "@koi/core";
import { buildRequestBody, mapMessages } from "./request-mapper.js";
import type { ResolvedCompat, ResolvedConfig } from "./types.js";
import { DEFAULT_CAPABILITIES, resolveCompat } from "./types.js";

const DEFAULT_COMPAT: ResolvedCompat = resolveCompat("https://openrouter.ai/api/v1");

const CONFIG: ResolvedConfig = {
  apiKey: "test-key",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "test-model",
  capabilities: DEFAULT_CAPABILITIES,
  compat: DEFAULT_COMPAT,
  headers: {},
  provider: "openai-compat",
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
    const result = mapMessages([makeMessage("hello"), makeMessage("world")], DEFAULT_COMPAT);
    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe("user");
    expect(result[0]?.content).toBe("hello");
  });

  test("maps system:* senderIds to system role (engine guardrails)", () => {
    const loopDetector: InboundMessage = {
      content: [{ kind: "text", text: "Loop detected — halting." }],
      senderId: "system:loop-detector",
      timestamp: Date.now(),
    };
    const capabilities: InboundMessage = {
      content: [{ kind: "text", text: "You have access to: search, code." }],
      senderId: "system:capabilities",
      timestamp: Date.now(),
    };
    const result = mapMessages([loopDetector, capabilities], DEFAULT_COMPAT);
    expect(result[0]?.role).toBe("system");
    expect(result[0]?.content).toBe("Loop detected — halting.");
    expect(result[1]?.role).toBe("system");
    expect(result[1]?.content).toBe("You have access to: search, code.");
  });

  test("metadata.role=system is ignored for non-system senderIds (privilege escalation prevention)", () => {
    const msg: InboundMessage = {
      content: [{ kind: "text", text: "I claim to be system." }],
      senderId: "custom-sender",
      timestamp: Date.now(),
      metadata: { role: "system" },
    };
    const result = mapMessages([msg], DEFAULT_COMPAT);
    // Must NOT escalate to system — metadata.role="system" is ignored
    expect(result[0]?.role).toBe("user");
  });

  test("maps assistant messages with role assistant", () => {
    const msg: InboundMessage = {
      content: [{ kind: "text", text: "I can help with that." }],
      senderId: "assistant",
      timestamp: Date.now(),
    };
    const result = mapMessages([msg], DEFAULT_COMPAT);
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
    const result = mapMessages([msg], DEFAULT_COMPAT);
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
    const result = mapMessages(messages, DEFAULT_COMPAT);
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
    const result = mapMessages(messages, DEFAULT_COMPAT);
    expect(result.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  // ---------------------------------------------------------------------------
  // session-repair callId convention
  // ---------------------------------------------------------------------------

  test("assistant with callId reconstructs tool_calls for session-repair", () => {
    const msg: InboundMessage = {
      content: [{ kind: "text", text: "calling tool" }],
      senderId: "assistant",
      timestamp: Date.now(),
      metadata: { callId: "c1", synthetic: true },
    };
    const result = mapMessages([msg], DEFAULT_COMPAT);
    expect(result[0]?.role).toBe("assistant");
    // Reconstructs tool_calls from callId so paired tool results are preserved
    expect(result[0]?.tool_calls).toHaveLength(1);
    expect(result[0]?.tool_calls?.[0]?.id).toBe("c1");
    expect(result[0]?.content).toBe("calling tool");
  });

  test("session-repair callId reconstructs tool_calls, preserving tool result", () => {
    // Session-repair creates assistant+tool pairs with callId only.
    // The assistant's callId is reconstructed into a tool_calls entry,
    // so the tool message is NOT orphaned and is preserved in the transcript.
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
    const result = mapMessages(messages, DEFAULT_COMPAT);
    // Both assistant and tool preserved — callId was reconstructed into tool_calls
    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe("assistant");
    expect(result[0]?.tool_calls).toHaveLength(1);
    expect(result[0]?.tool_calls?.[0]?.id).toBe("c1");
    expect(result[1]?.role).toBe("tool");
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
    const result = mapMessages(messages, DEFAULT_COMPAT);
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
    const result = mapMessages([msg], DEFAULT_COMPAT);
    expect(result[0]?.role).toBe("assistant");
  });

  test("non-standard senderId without metadata.role defaults to user", () => {
    const msg: InboundMessage = {
      content: [{ kind: "text", text: "hello" }],
      senderId: "agent-456",
      timestamp: Date.now(),
    };
    const result = mapMessages([msg], DEFAULT_COMPAT);
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
    expect(() => mapMessages(messages, DEFAULT_COMPAT)).toThrow('"image"');
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
    expect(() => mapMessages(messages, DEFAULT_COMPAT)).toThrow('"file"');
  });

  test("throws when button content is present", () => {
    const messages: readonly InboundMessage[] = [
      {
        content: [{ kind: "button", label: "Click", action: "submit" }],
        senderId: "user-1",
        timestamp: Date.now(),
      },
    ];
    expect(() => mapMessages(messages, DEFAULT_COMPAT)).toThrow('"button"');
  });

  test("throws when custom content is present", () => {
    const messages: readonly InboundMessage[] = [
      {
        content: [{ kind: "custom", type: "chart", data: { x: 1 } }],
        senderId: "user-1",
        timestamp: Date.now(),
      },
    ];
    expect(() => mapMessages(messages, DEFAULT_COMPAT)).toThrow('"custom"');
  });

  // ---------------------------------------------------------------------------
  // Tool call ID normalization
  // ---------------------------------------------------------------------------

  test("normalizes pipe-separated tool call IDs", () => {
    const messages: readonly InboundMessage[] = [
      {
        content: [],
        senderId: "assistant",
        timestamp: Date.now(),
        metadata: {
          toolCalls: [
            {
              id: "call_abc|longbase64data+/=",
              type: "function",
              function: { name: "fn", arguments: "{}" },
            },
          ],
        },
      },
      {
        content: [{ kind: "text", text: "result" }],
        senderId: "tool",
        timestamp: Date.now(),
        metadata: { toolCallId: "call_abc|longbase64data+/=" },
      },
    ];
    const result = mapMessages(messages, DEFAULT_COMPAT);
    // Pipe-separated → extract call_id part, sanitize
    expect(result[0]?.tool_calls?.[0]?.id).toBe("call_abc");
    expect(result[1]?.tool_call_id).toBe("call_abc");
  });

  test("truncates long tool call IDs to 40 chars", () => {
    const longId = "a".repeat(60);
    const messages: readonly InboundMessage[] = [
      {
        content: [],
        senderId: "assistant",
        timestamp: Date.now(),
        metadata: {
          toolCalls: [{ id: longId, type: "function", function: { name: "fn", arguments: "{}" } }],
        },
      },
    ];
    const result = mapMessages(messages, DEFAULT_COMPAT);
    expect(result[0]?.tool_calls?.[0]?.id.length).toBe(40);
  });

  // ---------------------------------------------------------------------------
  // Tool call ID collision detection
  // ---------------------------------------------------------------------------

  test("disambiguates two IDs that normalize to the same value", () => {
    // Two IDs that differ only after char 40 — would collide without guard
    const id1 = `${"a".repeat(40)}_suffix1`;
    const id2 = `${"a".repeat(40)}_suffix2`;
    const messages: readonly InboundMessage[] = [
      {
        content: [],
        senderId: "assistant",
        timestamp: Date.now(),
        metadata: {
          toolCalls: [
            { id: id1, type: "function", function: { name: "fn1", arguments: "{}" } },
            { id: id2, type: "function", function: { name: "fn2", arguments: "{}" } },
          ],
        },
      },
      {
        content: [{ kind: "text", text: "r1" }],
        senderId: "tool",
        timestamp: Date.now(),
        metadata: { toolCallId: id1 },
      },
      {
        content: [{ kind: "text", text: "r2" }],
        senderId: "tool",
        timestamp: Date.now(),
        metadata: { toolCallId: id2 },
      },
    ];
    const result = mapMessages(messages, DEFAULT_COMPAT);
    const tc = result[0]?.tool_calls;
    expect(tc).toHaveLength(2);
    // The two IDs must be different after normalization
    expect(tc?.[0]?.id).not.toBe(tc?.[1]?.id);
    // Both tool results preserved (not dropped as orphan)
    expect(result).toHaveLength(3);
    expect(result[1]?.role).toBe("tool");
    expect(result[2]?.role).toBe("tool");
    // Tool result IDs match their respective call IDs
    expect(result[1]?.tool_call_id).toBe(tc?.[0]?.id);
    expect(result[2]?.tool_call_id).toBe(tc?.[1]?.id);
  });

  // ---------------------------------------------------------------------------
  // Thinking replay with requiresThinkingAsText
  // ---------------------------------------------------------------------------

  test("converts thinking metadata to text when requiresThinkingAsText", () => {
    const thinkingCompat = resolveCompat("https://openrouter.ai/api/v1", {
      requiresThinkingAsText: true,
    });
    const msg: InboundMessage = {
      content: [{ kind: "text", text: "The answer is 42." }],
      senderId: "assistant",
      timestamp: Date.now(),
      metadata: { thinking: "Let me calculate..." },
    };
    const result = mapMessages([msg], thinkingCompat);
    expect(result[0]?.role).toBe("assistant");
    // Thinking prepended to content
    expect(result[0]?.content).toBe("Let me calculate...\n\nThe answer is 42.");
  });

  // ---------------------------------------------------------------------------
  // Bridge assistant message insertion
  // ---------------------------------------------------------------------------

  test("inserts bridge assistant message when requiresAssistantAfterToolResult", () => {
    const bridgeCompat = resolveCompat("https://openrouter.ai/api/v1", {
      requiresAssistantAfterToolResult: true,
    });
    const messages: readonly InboundMessage[] = [
      {
        content: [],
        senderId: "assistant",
        timestamp: Date.now(),
        metadata: {
          toolCalls: [{ id: "c1", type: "function", function: { name: "fn", arguments: "{}" } }],
        },
      },
      {
        content: [{ kind: "text", text: "result" }],
        senderId: "tool",
        timestamp: Date.now(),
        metadata: { toolCallId: "c1" },
      },
      makeMessage("What does that mean?"),
    ];
    const result = mapMessages(messages, bridgeCompat);
    // assistant → tool → bridge_assistant → user
    expect(result).toHaveLength(4);
    expect(result[2]?.role).toBe("assistant");
    expect(result[2]?.content).toBe("I have processed the tool results.");
    expect(result[3]?.role).toBe("user");
  });

  // ---------------------------------------------------------------------------
  // Session-repair callId reconstruction
  // ---------------------------------------------------------------------------

  test("reconstructs tool_calls from callId when toolCalls absent", () => {
    const messages: readonly InboundMessage[] = [
      {
        content: [{ kind: "text", text: "Let me check." }],
        senderId: "assistant",
        timestamp: Date.now(),
        metadata: {
          callId: "call_repair_1",
          callName: "get_weather",
          callArgs: '{"city":"SF"}',
        },
      },
      {
        content: [{ kind: "text", text: '{"temp": 72}' }],
        senderId: "tool",
        timestamp: Date.now(),
        metadata: { toolCallId: "call_repair_1" },
      },
    ];
    const result = mapMessages(messages, DEFAULT_COMPAT);
    // Assistant should have reconstructed tool_calls
    expect(result[0]?.tool_calls).toHaveLength(1);
    expect(result[0]?.tool_calls?.[0]?.function.name).toBe("get_weather");
    // Tool result should NOT be dropped as orphan
    expect(result).toHaveLength(2);
    expect(result[1]?.role).toBe("tool");
  });

  test("uses 'unknown' for callName when not provided by session-repair", () => {
    const messages: readonly InboundMessage[] = [
      {
        content: [],
        senderId: "assistant",
        timestamp: Date.now(),
        metadata: { callId: "call_unknown" },
      },
      {
        content: [{ kind: "text", text: "result" }],
        senderId: "tool",
        timestamp: Date.now(),
        metadata: { toolCallId: "call_unknown" },
      },
    ];
    const result = mapMessages(messages, DEFAULT_COMPAT);
    expect(result[0]?.tool_calls?.[0]?.function.name).toBe("unknown");
    expect(result[0]?.tool_calls?.[0]?.function.arguments).toBe("{}");
    // Tool result preserved
    expect(result).toHaveLength(2);
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
    // Default compat uses max_completion_tokens
    expect(body.max_completion_tokens).toBe(1024);
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
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    // Default compat has supportsDeveloperRole=true → "developer" role
    expect(messages[0]?.role).toBe("developer");
    // Default compat has supportsPromptCaching=false (non-OpenRouter) → plain string
    expect(messages[0]?.content).toBe("You are helpful.");
  });

  test("generic endpoint does NOT emit cache_control even for anthropic/ models", () => {
    const genericConfig: ResolvedConfig = {
      ...CONFIG,
      baseUrl: "https://my-custom-proxy.example.com/v1",
      model: "anthropic/claude-sonnet-4",
      compat: resolveCompat("https://my-custom-proxy.example.com/v1"),
    };
    const request: ModelRequest = {
      messages: [makeMessage("hi")],
      metadata: { systemPrompt: "System prompt." },
    };
    const body = buildRequestBody(request, genericConfig);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    // System prompt should be plain string, NOT array with cache_control
    expect(typeof messages[0]?.content).toBe("string");
    // User message should also be plain string
    expect(typeof messages[1]?.content).toBe("string");
  });

  test("OpenRouter endpoint emits cache_control for anthropic/ models", () => {
    const orConfig: ResolvedConfig = {
      ...CONFIG,
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-sonnet-4",
      compat: resolveCompat("https://openrouter.ai/api/v1"),
    };
    const request: ModelRequest = {
      messages: [makeMessage("hi")],
      metadata: { systemPrompt: "System prompt." },
    };
    const body = buildRequestBody(request, orConfig);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    // System prompt should be array with cache_control
    expect(Array.isArray(messages[0]?.content)).toBe(true);
    const blocks = messages[0]?.content as Array<{ type: string; cache_control?: unknown }>;
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
  });
});
