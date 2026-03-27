import { describe, expect, test } from "bun:test";
import type { EngineInput } from "@koi/core/engine";
import type { InboundMessage } from "@koi/core/message";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";
import {
  engineInputToHistory,
  engineInputToPrompt,
  inboundToPiMessage,
  inboundToPiMessages,
  PI_CAPABILITIES,
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

  test("detects assistant via metadata.originalRole when senderId is agentId", () => {
    const inbound: InboundMessage = {
      content: [{ kind: "text", text: "Hello from assistant" }],
      senderId: "koi-demo",
      timestamp: now,
      metadata: { fromHistory: true, originalRole: "assistant", agentId: "koi-demo" },
    };
    const result = inboundToPiMessage(inbound) as AssistantMessage;

    expect(result.role).toBe("assistant");
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "Hello from assistant" });
  });

  test("detects assistant via metadata.role when senderId is agentId", () => {
    const inbound: InboundMessage = {
      content: [{ kind: "text", text: "Labeled response" }],
      senderId: "my-agent",
      timestamp: now,
      metadata: { role: "assistant" },
    };
    const result = inboundToPiMessage(inbound) as AssistantMessage;

    expect(result.role).toBe("assistant");
    expect(Array.isArray(result.content)).toBe(true);
  });

  test("detects assistant via legacy agentId match", () => {
    const inbound: InboundMessage = {
      content: [{ kind: "text", text: "Legacy response" }],
      senderId: "old-agent",
      timestamp: now,
      metadata: { agentId: "old-agent" },
    };
    const result = inboundToPiMessage(inbound) as AssistantMessage;

    expect(result.role).toBe("assistant");
  });

  test("detects tool via metadata.originalRole", () => {
    const inbound: InboundMessage = {
      content: [{ kind: "text", text: "tool result" }],
      senderId: "some-tool-id",
      timestamp: now,
      metadata: {
        fromHistory: true,
        originalRole: "tool",
        toolCallId: "c1",
        toolName: "search",
        isError: false,
      },
    };
    const result = inboundToPiMessage(inbound) as ToolResultMessage;

    expect(result.role).toBe("toolResult");
  });

  test("does not misclassify user with agentId metadata as assistant", () => {
    const inbound: InboundMessage = {
      content: [{ kind: "text", text: "user message" }],
      senderId: "user-42",
      timestamp: now,
      metadata: { fromHistory: true, originalRole: "user", agentId: "koi-demo" },
    };
    const result = inboundToPiMessage(inbound) as UserMessage;

    expect(result.role).toBe("user");
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

  test("skips assistant messages with agentId senderId (metadata.originalRole)", () => {
    const input: EngineInput = {
      kind: "messages",
      messages: [
        {
          content: [{ kind: "text", text: "first" }],
          senderId: "user",
          timestamp: now - 1000,
        },
        {
          content: [{ kind: "text", text: "assistant response" }],
          senderId: "koi-demo",
          timestamp: now - 500,
          metadata: { fromHistory: true, originalRole: "assistant", agentId: "koi-demo" },
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

  test("skips assistant messages with agentId senderId even when last message", () => {
    const input: EngineInput = {
      kind: "messages",
      messages: [
        {
          content: [{ kind: "text", text: "user prompt" }],
          senderId: "user",
          timestamp: now - 500,
        },
        {
          content: [{ kind: "text", text: "assistant response" }],
          senderId: "koi-demo",
          timestamp: now,
          metadata: { originalRole: "assistant" },
        },
      ],
    };
    // Should skip the assistant message and find the user message
    expect(engineInputToPrompt(input)).toBe("user prompt");
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

  test("handles user message with image-only content (images supported, returns empty for non-text)", () => {
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
    // Image blocks pass through (pi supports images) but engineInputToPrompt
    // looks for text blocks — an image-only message has no text to extract
    expect(engineInputToPrompt(input)).toBe("");
  });

  test("file-only message returns empty prompt (files pass through, no text to extract)", () => {
    const input: EngineInput = {
      kind: "messages",
      messages: [
        {
          content: [
            {
              kind: "file",
              url: "https://example.com/doc.pdf",
              mimeType: "application/pdf",
              name: "doc.pdf",
            },
          ],
          senderId: "user",
          timestamp: now,
        },
      ],
    };
    // File blocks pass through (PI_CAPABILITIES.files = true), no text block to extract
    expect(engineInputToPrompt(input)).toBe("");
  });

  test("mixed file and text message extracts text", () => {
    const input: EngineInput = {
      kind: "messages",
      messages: [
        {
          content: [
            { kind: "file", url: "https://example.com/doc.pdf", mimeType: "application/pdf" },
            { kind: "text", text: "Summarize this document" },
          ],
          senderId: "user",
          timestamp: now,
        },
      ],
    };
    expect(engineInputToPrompt(input)).toBe("Summarize this document");
  });
});

// ---------------------------------------------------------------------------
// engineInputToHistory — assistant detection with agentId senderId
// ---------------------------------------------------------------------------

describe("engineInputToHistory", () => {
  test("correctly classifies assistant messages with agentId senderId as history", () => {
    const input: EngineInput = {
      kind: "messages",
      messages: [
        {
          content: [{ kind: "text", text: "first" }],
          senderId: "user",
          timestamp: now - 2000,
        },
        {
          content: [{ kind: "text", text: "assistant response" }],
          senderId: "koi-demo",
          timestamp: now - 1000,
          metadata: { fromHistory: true, originalRole: "assistant", agentId: "koi-demo" },
        },
        {
          content: [{ kind: "text", text: "second" }],
          senderId: "user",
          timestamp: now,
        },
      ],
    };
    const history = engineInputToHistory(input);

    // History should include user + assistant messages before the prompt
    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe("user");
    expect(history[1]?.role).toBe("assistant");
    // Assistant content must be array (not string) to avoid flatMap crash
    expect(Array.isArray(history[1]?.content)).toBe(true);
  });

  test("does not treat agentId-senderId assistant message as prompt", () => {
    const input: EngineInput = {
      kind: "messages",
      messages: [
        {
          content: [{ kind: "text", text: "user prompt" }],
          senderId: "user",
          timestamp: now - 500,
        },
        {
          content: [{ kind: "text", text: "assistant response" }],
          senderId: "my-agent",
          timestamp: now,
          metadata: { originalRole: "assistant" },
        },
      ],
    };
    const history = engineInputToHistory(input);

    // Prompt is the user message; assistant is not mistaken for prompt
    // lastUserIndex=0, so slice(0, 0) = empty (only the prompt, no prior history)
    expect(history).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// blocksToUserContent — FileBlock handling
// ---------------------------------------------------------------------------

describe("blocksToUserContent — FileBlock", () => {
  test("FileBlock with URL maps to Anthropic document block", () => {
    const msg: InboundMessage = {
      content: [
        {
          kind: "file",
          url: "https://example.com/report.pdf",
          mimeType: "application/pdf",
          name: "report.pdf",
        },
      ],
      senderId: "user",
      timestamp: now,
    };
    const piMsg = inboundToPiMessage(msg);
    expect(piMsg.role).toBe("user");
    if (piMsg.role === "user" && Array.isArray(piMsg.content)) {
      // @ts-expect-error — document block not in pi-ai types, passed through at runtime
      expect(piMsg.content[0]).toEqual({
        type: "document",
        source: { type: "url", url: "https://example.com/report.pdf" },
      });
    }
  });

  test("FileBlock with base64 data URL maps to Anthropic document block", () => {
    const msg: InboundMessage = {
      content: [
        {
          kind: "file",
          url: "data:application/pdf;base64,JVBERi0xLjQK",
          mimeType: "application/pdf",
          name: "report.pdf",
        },
      ],
      senderId: "user",
      timestamp: now,
    };
    const piMsg = inboundToPiMessage(msg);
    expect(piMsg.role).toBe("user");
    if (piMsg.role === "user" && Array.isArray(piMsg.content)) {
      // @ts-expect-error — document block not in pi-ai types, passed through at runtime
      expect(piMsg.content[0]).toEqual({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" },
      });
    }
  });

  test("FileBlock in tool result maps to Anthropic document block", () => {
    const msg: InboundMessage = {
      content: [
        {
          kind: "file",
          url: "https://example.com/result.csv",
          mimeType: "text/csv",
          name: "result.csv",
        },
      ],
      senderId: "tool",
      timestamp: now,
      metadata: { toolCallId: "call-1", toolName: "export", isError: false },
    };
    const piMsg = inboundToPiMessage(msg);
    expect(piMsg.role).toBe("toolResult");
    if (piMsg.role === "toolResult") {
      // @ts-expect-error — document block not in pi-ai types, passed through at runtime
      expect(piMsg.content[0]).toEqual({
        type: "document",
        source: { type: "url", url: "https://example.com/result.csv" },
      });
    }
  });
});

// ---------------------------------------------------------------------------
// PI_CAPABILITIES export
// ---------------------------------------------------------------------------

describe("PI_CAPABILITIES", () => {
  test("declares images and files supported", () => {
    expect(PI_CAPABILITIES).toEqual({
      text: true,
      images: true,
      files: true,
      audio: false,
    });
  });
});
