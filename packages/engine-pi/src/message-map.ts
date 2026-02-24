/**
 * Message conversion between pi Message types and Koi InboundMessage.
 *
 * pi Message → Koi InboundMessage: for middleware inspection
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
