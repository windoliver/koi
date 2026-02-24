/**
 * Message conversion between pi Message types and Koi InboundMessage.
 *
 * pi Message → Koi InboundMessage: for middleware inspection (forward)
 * Koi InboundMessage → pi Message: for middleware-modified messages (reverse)
 * EngineInput → pi prompt string: for initiating the agent loop
 */

import type { EngineInput } from "@koi/core/engine";
import type { ContentBlock, InboundMessage } from "@koi/core/message";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";

/**
 * Convert a pi Message to a Koi InboundMessage for middleware inspection.
 */
export function piMessageToInbound(msg: Message): InboundMessage {
  switch (msg.role) {
    case "user":
      return {
        content: userContentToBlocks(msg),
        senderId: "user",
        timestamp: msg.timestamp,
      };

    case "assistant":
      return {
        content: assistantContentToBlocks(msg),
        senderId: "assistant",
        timestamp: msg.timestamp,
      };

    case "toolResult":
      return {
        content: toolResultToBlocks(msg),
        senderId: "tool",
        timestamp: msg.timestamp,
        metadata: {
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          isError: msg.isError,
        },
      };
  }
}

/**
 * Convert an array of pi Messages to Koi InboundMessages.
 */
export function piMessagesToInbound(messages: readonly Message[]): readonly InboundMessage[] {
  return messages.map(piMessageToInbound);
}

// ---------------------------------------------------------------------------
// Reverse conversion: Koi InboundMessage → pi Message
// ---------------------------------------------------------------------------

/**
 * Convert a Koi InboundMessage back to a pi Message.
 *
 * Round-trip is lossy for AssistantMessage response metadata (usage, provider, api).
 * This is acceptable because compactor summary messages become UserMessages, and
 * preserved recent messages only need valid role/content for the Anthropic API request.
 */
export function inboundToPiMessage(msg: InboundMessage): Message {
  if (msg.senderId === "assistant") {
    return inboundToAssistantMessage(msg);
  }
  if (msg.senderId === "tool") {
    return inboundToToolResultMessage(msg);
  }
  // "user", "system:compactor", or any other senderId → UserMessage
  return inboundToUserMessage(msg);
}

/**
 * Convert an array of Koi InboundMessages back to pi Messages.
 */
export function inboundToPiMessages(messages: readonly InboundMessage[]): Message[] {
  return messages.map(inboundToPiMessage);
}

/**
 * Extract the prompt text from an EngineInput.
 */
export function engineInputToPrompt(input: EngineInput): string {
  switch (input.kind) {
    case "text":
      return input.text;
    case "messages": {
      // Search backwards for the last non-assistant message with text content.
      // senderId is channel-specific and not always "user" — only "assistant" is
      // a reliable sentinel for skipping model-generated messages.
      for (let i = input.messages.length - 1; i >= 0; i--) {
        const msg = input.messages[i];
        if (msg && msg.senderId !== "assistant") {
          const textBlock = msg.content.find((c) => c.kind === "text");
          if (textBlock?.kind === "text") {
            return textBlock.text;
          }
        }
      }
      return "";
    }
    case "resume":
      return "";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function userContentToBlocks(msg: UserMessage): readonly ContentBlock[] {
  if (typeof msg.content === "string") {
    return [{ kind: "text", text: msg.content }];
  }
  return msg.content.map((part): ContentBlock => {
    switch (part.type) {
      case "text":
        return { kind: "text", text: part.text };
      case "image":
        return { kind: "image", url: `data:${part.mimeType};base64,${part.data}` };
      default:
        return { kind: "custom", type: (part as { readonly type: string }).type, data: {} };
    }
  });
}

function assistantContentToBlocks(msg: AssistantMessage): readonly ContentBlock[] {
  return msg.content.map((part): ContentBlock => {
    switch (part.type) {
      case "text":
        return { kind: "text", text: part.text };
      case "thinking":
        return { kind: "custom", type: "thinking", data: { thinking: part.thinking } };
      case "toolCall":
        return {
          kind: "custom",
          type: "tool_call",
          data: { id: part.id, name: part.name, arguments: part.arguments },
        };
      default:
        return { kind: "custom", type: (part as { readonly type: string }).type, data: {} };
    }
  });
}

function toolResultToBlocks(msg: ToolResultMessage): readonly ContentBlock[] {
  return msg.content.map((part): ContentBlock => {
    switch (part.type) {
      case "text":
        return { kind: "text", text: part.text };
      case "image":
        return { kind: "image", url: `data:${part.mimeType};base64,${part.data}` };
      default:
        return { kind: "custom", type: (part as { readonly type: string }).type, data: {} };
    }
  });
}

// ---------------------------------------------------------------------------
// Reverse conversion helpers: Koi InboundMessage → pi Message
// ---------------------------------------------------------------------------

function inboundToUserMessage(msg: InboundMessage): UserMessage {
  // Single text block → string content (most common case, simpler for the API)
  if (msg.content.length === 1 && msg.content[0]?.kind === "text") {
    return { role: "user", content: msg.content[0].text, timestamp: msg.timestamp };
  }
  // Multiple blocks or non-text → array content
  const content = msg.content.map(blocksToUserContent);
  return { role: "user", content, timestamp: msg.timestamp };
}

function inboundToAssistantMessage(msg: InboundMessage): AssistantMessage {
  const content = msg.content.map(blockToAssistantContent);
  // Placeholder metadata — only role + content matter for the API request
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: msg.timestamp,
  };
}

function inboundToToolResultMessage(msg: InboundMessage): ToolResultMessage {
  const meta = msg.metadata;
  const toolCallId = typeof meta?.toolCallId === "string" ? meta.toolCallId : "";
  const toolName = typeof meta?.toolName === "string" ? meta.toolName : "";
  const isError = typeof meta?.isError === "boolean" ? meta.isError : false;
  const content = msg.content.map(blocksToToolResultContent);
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content,
    isError,
    timestamp: msg.timestamp,
  };
}

function blocksToUserContent(
  block: ContentBlock,
):
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string } {
  if (block.kind === "text") {
    return { type: "text", text: block.text };
  }
  if (block.kind === "image") {
    // Reverse data:mimeType;base64,data → { data, mimeType }
    const parsed = parseDataUrl(block.url);
    return { type: "image", data: parsed.data, mimeType: parsed.mimeType };
  }
  // Fallback for custom/other blocks — treat as text
  return { type: "text", text: "" };
}

function blockToAssistantContent(block: ContentBlock): AssistantMessage["content"][number] {
  if (block.kind === "text") {
    return { type: "text", text: block.text };
  }
  if (block.kind === "custom" && block.type === "thinking") {
    const d = isRecord(block.data) ? block.data : undefined;
    const thinking = typeof d?.thinking === "string" ? d.thinking : "";
    return { type: "thinking", thinking };
  }
  if (block.kind === "custom" && block.type === "tool_call") {
    const d = isRecord(block.data) ? block.data : undefined;
    const id = typeof d?.id === "string" ? d.id : "";
    const name = typeof d?.name === "string" ? d.name : "";
    const args = isRecord(d?.arguments) ? d.arguments : {};
    return { type: "toolCall", id, name, arguments: args };
  }
  // Fallback
  return { type: "text", text: "" };
}

function blocksToToolResultContent(
  block: ContentBlock,
):
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string } {
  if (block.kind === "text") {
    return { type: "text", text: block.text };
  }
  if (block.kind === "image") {
    const parsed = parseDataUrl(block.url);
    return { type: "image", data: parsed.data, mimeType: parsed.mimeType };
  }
  return { type: "text", text: "" };
}

/** Type guard: narrows unknown to Record<string, unknown> */
function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function parseDataUrl(url: string): { readonly data: string; readonly mimeType: string } {
  // Expected format: data:mimeType;base64,data
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return { mimeType: match[1], data: match[2] };
  }
  return { mimeType: "application/octet-stream", data: "" };
}
