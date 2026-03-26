/**
 * Message conversion between pi Message types and Koi InboundMessage.
 *
 * pi Message → Koi InboundMessage: for middleware inspection (forward)
 * Koi InboundMessage → pi Message: for middleware-modified messages (reverse)
 * EngineInput → pi prompt string: for initiating the agent loop
 */

import type { EngineCapabilities, EngineInput } from "@koi/core/engine";
import { mapContentBlocksForEngine } from "@koi/core/engine";
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
  // Conversation middleware stores assistant messages with agentId as senderId
  // (e.g., "koi-demo", "agent-1"). Detect these via fromHistory metadata + role,
  // or by checking that senderId is not a known user/system pattern.
  // The metadata.fromHistory + original role is the most reliable signal.
  const meta = msg.metadata as Record<string, unknown> | undefined;
  if (meta?.fromHistory === true) {
    // ThreadMessage.role was "assistant" → senderId was set to agentId
    // ThreadMessage.role was "tool" → senderId was set to "tool" (already caught above)
    // ThreadMessage.role was "user" → senderId was set to userId (e.g., "user-42") or "user"
    // ThreadMessage.role was "system" → senderId was set to "system"
    //
    // Use originalRole metadata (set by conversation middleware) when available
    // to avoid misclassifying named users (e.g., "user-42") as assistant.
    const originalRole = meta.originalRole;
    if (typeof originalRole === "string") {
      if (originalRole === "assistant") return inboundToAssistantMessage(msg);
      // originalRole is "user"/"system"/"tool" → fall through to UserMessage
    } else {
      // Legacy path: no originalRole metadata.
      // Positive-match agent senderIds rather than excluding user patterns.
      // Agent IDs in Koi follow "name" or "name-suffix" from the manifest —
      // they're never UUIDs/emails. The conversation middleware sets senderId
      // to the agentId for assistant messages. Match common agent ID patterns.
      // Default to user (safe) if uncertain — misclassifying user as assistant
      // is worse than the reverse.
      const agentName = meta.agentId;
      if (typeof agentName === "string" && msg.senderId === agentName) {
        return inboundToAssistantMessage(msg);
      }
      // No agentId metadata and no originalRole → default to user (safe).
      // This may misclassify assistant messages from very old history that
      // lacks both metadata fields, but that's safer than the reverse.
    }
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
 * Pi engine capabilities — images and files supported natively.
 * The pi-ai SDK passes content arrays through to the Anthropic API
 * without type validation, so document blocks reach the model at runtime
 * even though pi-ai's TypeScript types only declare text and image.
 */
export const PI_CAPABILITIES: EngineCapabilities = {
  text: true,
  images: true,
  files: true,
  audio: false,
} as const;

/**
 * Extract the prompt text from an EngineInput.
 * Applies mapContentBlocksForEngine defensively before extracting text.
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
          const mapped = mapContentBlocksForEngine(msg.content, PI_CAPABILITIES);
          const textBlock = mapped.find((c) => c.kind === "text");
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

/**
 * Extract history messages from an EngineInput, converted to pi Message format.
 *
 * - "text": no history — the prompt string is the only input.
 * - "messages": returns all messages except the last non-assistant message
 *   (which becomes the prompt string via engineInputToPrompt). This preserves
 *   conversation history, tool results, and attachments for the pi Agent's
 *   initial context.
 * - "resume": returns all messages from the resume state, converted to pi format.
 */
export function engineInputToHistory(input: EngineInput): readonly Message[] {
  switch (input.kind) {
    case "text":
      return [];
    case "messages": {
      // Find the index of the last non-assistant message (the one used as prompt).
      // Everything before it is history that must be preserved.
      let lastUserIndex = -1;
      for (let i = input.messages.length - 1; i >= 0; i--) {
        const msg = input.messages[i];
        if (msg && msg.senderId !== "assistant") {
          const mapped = mapContentBlocksForEngine(msg.content, PI_CAPABILITIES);
          const textBlock = mapped.find((c) => c.kind === "text");
          if (textBlock?.kind === "text") {
            lastUserIndex = i;
            break;
          }
        }
      }
      if (lastUserIndex <= 0) return [];
      // Convert all messages before the prompt message to pi format
      return input.messages.slice(0, lastUserIndex).map(inboundToPiMessage);
    }
    case "resume": {
      // For resume, convert all available messages in the state to pi format.
      // The adapter calls piAgent.continue() instead of prompt(), so all
      // messages become history context.
      if (
        typeof input.state.data !== "object" ||
        input.state.data === null ||
        !("messages" in input.state.data)
      ) {
        return [];
      }
      const record = input.state.data as Record<string, unknown>;
      if (!Array.isArray(record.messages)) return [];
      // Filter to structurally valid InboundMessages, then convert
      return record.messages.filter(isInboundLike).map(inboundToPiMessage);
    }
  }
}

/**
 * Structural check for InboundMessage shape — used by engineInputToHistory
 * to filter unknown state data before conversion.
 */
function isInboundLike(value: unknown): value is InboundMessage {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r.content) && typeof r.senderId === "string" && typeof r.timestamp === "number"
  );
}

// ---------------------------------------------------------------------------
// Anthropic document content — passthrough via pi-ai SDK
// ---------------------------------------------------------------------------

/**
 * Anthropic document source — base64-encoded or URL-referenced.
 * Not declared by pi-ai types, but the SDK passes content through
 * to the Anthropic API without filtering at runtime.
 */
type DocumentSource =
  | { readonly type: "base64"; readonly media_type: string; readonly data: string }
  | { readonly type: "url"; readonly url: string };

/**
 * Content part union including Anthropic document blocks.
 * Wider than pi-ai's declared types — used for the reverse conversion
 * path (Koi → pi) where document blocks must reach the API.
 */
type PiContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  | { readonly type: "document"; readonly source: DocumentSource };

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
  const content = msg.content.map(blockToPiContent);
  // @ts-expect-error — PiContentPart[] includes Anthropic document blocks not in pi-ai types
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
  const content = msg.content.map(blockToPiContent);
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    // @ts-expect-error — PiContentPart[] includes Anthropic document blocks not in pi-ai types
    content,
    isError,
    timestamp: msg.timestamp,
  };
}

/**
 * Map a Koi ContentBlock to a pi-ai content part.
 * Used for both user messages and tool results — same mapping applies.
 * FileBlock → Anthropic document block (pi-ai SDK passes through at runtime).
 */
function blockToPiContent(block: ContentBlock): PiContentPart {
  if (block.kind === "text") {
    return { type: "text", text: block.text };
  }
  if (block.kind === "image") {
    const parsed = parseDataUrl(block.url);
    return { type: "image", data: parsed.data, mimeType: parsed.mimeType };
  }
  if (block.kind === "file") {
    if (block.url.startsWith("data:")) {
      const parsed = parseDataUrl(block.url);
      return {
        type: "document",
        source: { type: "base64", media_type: parsed.mimeType, data: parsed.data },
      };
    }
    return {
      type: "document",
      source: { type: "url", url: block.url },
    };
  }
  // Fallback for custom/button/other blocks
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
