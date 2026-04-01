/**
 * Map Koi ModelRequest → OpenAI Chat Completions request body.
 *
 * Role mapping convention (must match session-repair):
 * - metadata.role is authoritative when present ("assistant" | "tool" | "user")
 * - Falls back to senderId heuristic: "assistant" → assistant, "tool" → tool, else user
 * - Tool call linkage uses metadata.callId (session-repair convention)
 */

import type { InboundMessage, JsonObject, ModelRequest } from "@koi/core";
import type {
  ChatCompletionMessage,
  ChatCompletionTool,
  ChatCompletionToolCall,
  ResolvedConfig,
} from "./types.js";

/**
 * Find the first non-text block kind in messages, or undefined if all text.
 */
function findNonTextBlockKind(messages: readonly InboundMessage[]): string | undefined {
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.kind !== "text") return block.kind;
    }
  }
  return undefined;
}

/**
 * Extract text content from a message's content blocks.
 */
function extractText(msg: InboundMessage): string {
  return msg.content
    .filter((b): b is import("@koi/core").TextBlock => b.kind === "text")
    .map((b) => b.text)
    .join("");
}

/** Read a string from metadata, or undefined. */
function readStringMeta(metadata: JsonObject | undefined, key: string): string | undefined {
  if (metadata === undefined) return undefined;
  const val = metadata[key];
  return typeof val === "string" ? val : undefined;
}

/**
 * Determine the Chat Completions role for an InboundMessage.
 *
 * TRUST BOUNDARY: metadata.role, metadata.callId, metadata.toolCalls, and
 * metadata.systemPrompt are trusted because InboundMessage is an internal type
 * populated by L1 (engine), middleware, and session-repair — never directly by
 * external user input. The channel adapter layer validates and sanitizes
 * external input before it becomes an InboundMessage. If this assumption
 * changes, these fields must be moved to a separate trusted structure.
 *
 * Priority:
 * 1. metadata.role (explicit, authoritative — set by engine/middleware)
 * 2. senderId heuristic ("assistant", "tool")
 * 3. Default to "user"
 */
function resolveRole(msg: InboundMessage): "user" | "assistant" | "tool" {
  const explicitRole = readStringMeta(msg.metadata, "role");
  if (explicitRole === "assistant" || explicitRole === "tool" || explicitRole === "user") {
    return explicitRole;
  }
  if (msg.senderId === "assistant") return "assistant";
  if (msg.senderId === "tool") return "tool";
  return "user";
}

/**
 * Map a single InboundMessage to a Chat Completions message.
 * Uses metadata.callId for tool linkage (session-repair convention).
 */
function mapOneMessage(msg: InboundMessage): ChatCompletionMessage {
  const text = extractText(msg);
  const role = resolveRole(msg);

  if (role === "assistant") {
    // Tool calls: session-repair stores callId in metadata.callId.
    // Full tool_calls array may be in metadata.toolCalls (adapter round-trip).
    const toolCalls = msg.metadata?.toolCalls as readonly ChatCompletionToolCall[] | undefined;
    const _callId = readStringMeta(msg.metadata, "callId");

    // Only include tool_calls when the full call data is available.
    // Session-repair synthetic messages with only callId (no name/args)
    // cannot be faithfully represented — omit tool_calls rather than
    // fabricating placeholder entries that providers may reject.
    return {
      role: "assistant",
      content: text.length > 0 ? text : null,
      ...(toolCalls !== undefined && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }

  if (role === "tool") {
    // Tool call ID: prefer metadata.toolCallId, fall back to metadata.callId
    const toolCallId =
      readStringMeta(msg.metadata, "toolCallId") ?? readStringMeta(msg.metadata, "callId");
    return {
      role: "tool",
      content: text,
      ...(toolCallId !== undefined ? { tool_call_id: toolCallId } : {}),
    };
  }

  return { role: "user", content: text };
}

/**
 * Post-process mapped messages to ensure valid Chat Completions transcript ordering.
 *
 * Fixes orphaned tool messages (role: "tool" with no preceding assistant tool_calls)
 * by converting them to user messages. This handles session-repair synthetic histories
 * where callId-only assistant messages can't carry tool_calls.
 */
function fixOrphanedToolMessages(
  messages: readonly ChatCompletionMessage[],
): readonly ChatCompletionMessage[] {
  // Track which tool_call IDs have been declared by assistant messages
  const declaredCallIds = new Set<string>();
  const result: ChatCompletionMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls !== undefined) {
      for (const tc of msg.tool_calls) {
        declaredCallIds.add(tc.id);
      }
      result.push(msg);
    } else if (msg.role === "tool") {
      if (msg.tool_call_id !== undefined && declaredCallIds.has(msg.tool_call_id)) {
        result.push(msg);
      }
      // Orphaned tool messages are dropped entirely — tool results are
      // privileged internal data and must not be relabeled as user input.
    } else {
      result.push(msg);
    }
  }

  return result;
}

/**
 * Convert Koi InboundMessage[] to OpenAI Chat Completions message array.
 * Preserves message roles based on metadata/senderId for multi-turn fidelity.
 * Throws if messages contain non-text content blocks.
 */
export function mapMessages(messages: readonly InboundMessage[]): readonly ChatCompletionMessage[] {
  // Fail closed: only text blocks are supported. Reject any non-text content
  // (image, file, button, custom) to prevent silent data loss.
  const unsupported = findNonTextBlockKind(messages);
  if (unsupported !== undefined) {
    throw new Error(
      `Request contains "${unsupported}" content blocks but only text is supported. ` +
        "Non-text content would be silently dropped.",
    );
  }

  const mapped = messages.map(mapOneMessage);
  return fixOrphanedToolMessages(mapped);
}

/**
 * Build the complete request body for the Chat Completions API.
 */
export function buildRequestBody(
  request: ModelRequest,
  config: ResolvedConfig,
  tools?: readonly ChatCompletionTool[],
): Record<string, unknown> {
  const messages: ChatCompletionMessage[] = [];

  // System prompt from metadata or first message context
  const systemPrompt = request.metadata?.systemPrompt as string | undefined;
  if (systemPrompt !== undefined) {
    messages.push({ role: "system", content: systemPrompt });
  }

  // Conversation messages — preserves roles, validates content blocks
  messages.push(...mapMessages(request.messages));

  const body: Record<string, unknown> = {
    model: request.model ?? config.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }

  if (request.maxTokens !== undefined) {
    body.max_tokens = request.maxTokens;
  }

  if (tools !== undefined && tools.length > 0) {
    body.tools = tools;
  }

  return body;
}
