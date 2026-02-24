import { describe, expect, test } from "bun:test";
import type { EngineInput } from "@koi/core/engine";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";
import {
  engineInputToPrompt,
  inboundToPiMessage,
  inboundToPiMessages,
  piMessagesToInbound,
  piMessageToInbound,
} from "./message-map.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = Date.now();

function makeUserMessage(content: UserMessage["content"]): UserMessage {
  return { role: "user", content, timestamp: now };
}

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: now,
  };
}

function makeToolResultMessage(overrides?: Partial<ToolResultMessage>): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "search",
    content: [{ type: "text", text: "result" }],
    isError: false,
    timestamp: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// piMessageToInbound — UserMessage
// ---------------------------------------------------------------------------

describe("piMessageToInbound", () => {
  test("converts UserMessage with string content", () => {
    const msg = makeUserMessage("hello");
    const result = piMessageToInbound(msg);

    expect(result.senderId).toBe("user");
    expect(result.timestamp).toBe(now);
    expect(result.content).toEqual([{ kind: "text", text: "hello" }]);
  });

  test("converts UserMessage with array content", () => {
    const msg = makeUserMessage([
      { type: "text", text: "look at this" },
      { type: "image", data: "base64data", mimeType: "image/png" },
    ]);
    const result = piMessageToInbound(msg);

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ kind: "text", text: "look at this" });
    expect(result.content[1]).toEqual({
      kind: "image",
      url: "data:image/png;base64,base64data",
    });
  });

  test("converts AssistantMessage with text content", () => {
    const msg = makeAssistantMessage([{ type: "text", text: "I can help" }]);
    const result = piMessageToInbound(msg);

    expect(result.senderId).toBe("assistant");
    expect(result.content).toEqual([{ kind: "text", text: "I can help" }]);
  });

  test("converts AssistantMessage with thinking content", () => {
    const msg = makeAssistantMessage([{ type: "thinking", thinking: "Let me think..." }]);
    const result = piMessageToInbound(msg);

    expect(result.content[0]).toEqual({
      kind: "custom",
      type: "thinking",
      data: { thinking: "Let me think..." },
    });
  });

  test("converts AssistantMessage with toolCall content", () => {
    const msg = makeAssistantMessage([
      { type: "toolCall", id: "call-1", name: "search", arguments: { q: "test" } },
    ]);
    const result = piMessageToInbound(msg);

    expect(result.content[0]).toEqual({
      kind: "custom",
      type: "tool_call",
      data: { id: "call-1", name: "search", arguments: { q: "test" } },
    });
  });

  test("converts ToolResultMessage", () => {
    const msg = makeToolResultMessage();
    const result = piMessageToInbound(msg);

    expect(result.senderId).toBe("tool");
    expect(result.content).toEqual([{ kind: "text", text: "result" }]);
    expect(result.metadata).toEqual({
      toolCallId: "call-1",
      toolName: "search",
      isError: false,
    });
  });

  test("converts ToolResultMessage with error flag", () => {
    const msg = makeToolResultMessage({ isError: true });
    const result = piMessageToInbound(msg);

    expect(result.metadata?.isError).toBe(true);
  });

  test("converts ToolResultMessage with image content", () => {
    const msg = makeToolResultMessage({
      content: [{ type: "image", data: "imgdata", mimeType: "image/jpeg" }],
    });
    const result = piMessageToInbound(msg);

    expect(result.content[0]).toEqual({
      kind: "image",
      url: "data:image/jpeg;base64,imgdata",
    });
  });
});

// ---------------------------------------------------------------------------
// piMessagesToInbound
// ---------------------------------------------------------------------------

describe("piMessagesToInbound", () => {
  test("converts array of mixed messages", () => {
    const messages: Message[] = [
      makeUserMessage("hello"),
      makeAssistantMessage([{ type: "text", text: "hi" }]),
    ];
    const result = piMessagesToInbound(messages);

    expect(result).toHaveLength(2);
    expect(result[0]?.senderId).toBe("user");
    expect(result[1]?.senderId).toBe("assistant");
  });

  test("handles empty array", () => {
    expect(piMessagesToInbound([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// inboundToPiMessage — reverse converter
// ---------------------------------------------------------------------------

describe("inboundToPiMessage", () => {
  test("converts user text message to UserMessage", () => {
    const inbound = piMessageToInbound(makeUserMessage("hello"));
    const result = inboundToPiMessage(inbound);

    expect(result.role).toBe("user");
    expect((result as UserMessage).content).toBe("hello");
    expect(result.timestamp).toBe(now);
  });

  test("converts user message with content parts to UserMessage", () => {
    const inbound = piMessageToInbound(
      makeUserMessage([
        { type: "text", text: "look at this" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ]),
    );
    const result = inboundToPiMessage(inbound) as UserMessage;

    expect(result.role).toBe("user");
    expect(Array.isArray(result.content)).toBe(true);
    const parts = result.content as (
      | { readonly type: "text"; readonly text: string }
      | { readonly type: "image"; readonly data: string; readonly mimeType: string }
    )[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "look at this" });
    expect(parts[1]).toEqual({ type: "image", data: "base64data", mimeType: "image/png" });
  });

  test("converts system:compactor message to UserMessage", () => {
    const inbound = {
      content: [{ kind: "text" as const, text: "Summary of previous conversation." }],
      senderId: "system:compactor",
      timestamp: now,
      metadata: { compacted: true },
    };
    const result = inboundToPiMessage(inbound) as UserMessage;

    expect(result.role).toBe("user");
    expect(result.content).toBe("Summary of previous conversation.");
    expect(result.timestamp).toBe(now);
  });

  test("converts assistant text message to AssistantMessage", () => {
    const inbound = piMessageToInbound(
      makeAssistantMessage([{ type: "text", text: "I can help" }]),
    );
    const result = inboundToPiMessage(inbound) as AssistantMessage;

    expect(result.role).toBe("assistant");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "I can help" });
    expect(result.timestamp).toBe(now);
  });

  test("converts assistant message with tool calls to AssistantMessage", () => {
    const inbound = piMessageToInbound(
      makeAssistantMessage([
        { type: "text", text: "Let me search" },
        { type: "toolCall", id: "call-1", name: "search", arguments: { q: "test" } },
      ]),
    );
    const result = inboundToPiMessage(inbound) as AssistantMessage;

    expect(result.role).toBe("assistant");
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "text", text: "Let me search" });
    expect(result.content[1]).toEqual({
      type: "toolCall",
      id: "call-1",
      name: "search",
      arguments: { q: "test" },
    });
  });

  test("converts tool result message to ToolResultMessage", () => {
    const inbound = piMessageToInbound(makeToolResultMessage());
    const result = inboundToPiMessage(inbound) as ToolResultMessage;

    expect(result.role).toBe("toolResult");
    expect(result.toolCallId).toBe("call-1");
    expect(result.toolName).toBe("search");
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "result" });
  });

  test("converts tool result with image content", () => {
    const inbound = piMessageToInbound(
      makeToolResultMessage({
        content: [{ type: "image", data: "imgdata", mimeType: "image/jpeg" }],
      }),
    );
    const result = inboundToPiMessage(inbound) as ToolResultMessage;

    expect(result.role).toBe("toolResult");
    expect(result.content[0]).toEqual({ type: "image", data: "imgdata", mimeType: "image/jpeg" });
  });
});

// ---------------------------------------------------------------------------
// inboundToPiMessages — array reverse converter
// ---------------------------------------------------------------------------

describe("inboundToPiMessages", () => {
  test("converts array of mixed inbound messages", () => {
    const messages = piMessagesToInbound([
      makeUserMessage("hello"),
      makeAssistantMessage([{ type: "text", text: "hi" }]),
      makeToolResultMessage(),
    ]);
    const result = inboundToPiMessages(messages);

    expect(result).toHaveLength(3);
    expect(result[0]?.role).toBe("user");
    expect(result[1]?.role).toBe("assistant");
    expect(result[2]?.role).toBe("toolResult");
  });

  test("handles empty array", () => {
    expect(inboundToPiMessages([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// engineInputToPrompt
// ---------------------------------------------------------------------------

describe("engineInputToPrompt", () => {
  test("extracts text from text input", () => {
    const input: EngineInput = { kind: "text", text: "do something" };
    expect(engineInputToPrompt(input)).toBe("do something");
  });

  test("extracts last user message text from messages input", () => {
    const input: EngineInput = {
      kind: "messages",
      messages: [
        {
          content: [{ kind: "text", text: "first" }],
          senderId: "user",
          timestamp: now - 1000,
        },
        {
          content: [{ kind: "text", text: "response" }],
          senderId: "assistant",
          timestamp: now - 500,
        },
        {
          content: [{ kind: "text", text: "second" }],
          senderId: "user",
          timestamp: now,
        },
      ],
    };
    expect(engineInputToPrompt(input)).toBe("second");
  });

  test("returns empty string for messages input with no user messages", () => {
    const input: EngineInput = {
      kind: "messages",
      messages: [
        {
          content: [{ kind: "text", text: "response" }],
          senderId: "assistant",
          timestamp: now,
        },
      ],
    };
    expect(engineInputToPrompt(input)).toBe("");
  });

  test("returns empty string for resume input", () => {
    const input: EngineInput = {
      kind: "resume",
      state: { engineId: "pi-agent-core", data: null },
    };
    expect(engineInputToPrompt(input)).toBe("");
  });

  test("handles user message with non-text content blocks", () => {
    const input: EngineInput = {
      kind: "messages",
      messages: [
        {
          content: [{ kind: "image", url: "http://example.com/img.png" }],
          senderId: "user",
          timestamp: now,
        },
      ],
    };
    expect(engineInputToPrompt(input)).toBe("");
  });
});
