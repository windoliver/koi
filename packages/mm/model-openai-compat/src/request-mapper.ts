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
  ResolvedCompat,
  ResolvedConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Tool call ID normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a tool call ID for provider compatibility.
 *
 * Handles:
 * - Pipe-separated IDs from OpenAI Responses API (format: `{call_id}|{id}`)
 * - Sanitizes to allowed chars (alphanumeric, underscore, hyphen)
 * - Truncates to 40 chars (OpenAI limit)
 */
function normalizeToolCallId(id: string): string {
  // Handle pipe-separated IDs — extract just the call_id part
  const base = id.includes("|") ? (id.split("|")[0] ?? id) : id;
  // Sanitize to allowed characters and truncate
  return base.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

/** Find the first non-text block kind in messages, or undefined if all text. */
function findNonTextBlockKind(messages: readonly InboundMessage[]): string | undefined {
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.kind !== "text") return block.kind;
    }
  }
  return undefined;
}

/** Extract text content from a message's content blocks. */
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

// ---------------------------------------------------------------------------
// Role resolution
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Per-message mapping
// ---------------------------------------------------------------------------

/**
 * Map a single InboundMessage to a Chat Completions message.
 * Uses metadata.callId for tool linkage (session-repair convention).
 */
function mapOneMessage(msg: InboundMessage, compat: ResolvedCompat): ChatCompletionMessage {
  const text = extractText(msg);
  const role = resolveRole(msg);

  if (role === "assistant") {
    let toolCalls = msg.metadata?.toolCalls as readonly ChatCompletionToolCall[] | undefined;

    // Session-repair fallback: when full toolCalls array is absent but callId
    // is present, reconstruct a minimal tool_calls entry. Without this,
    // fixTranscriptOrdering would drop the following tool result as orphaned,
    // silently losing prior tool outputs from the conversation history.
    if (
      (toolCalls === undefined || toolCalls.length === 0) &&
      readStringMeta(msg.metadata, "callId") !== undefined
    ) {
      const callId = readStringMeta(msg.metadata, "callId")!;
      const callName = readStringMeta(msg.metadata, "callName") ?? "unknown";
      const callArgs = readStringMeta(msg.metadata, "callArgs") ?? "{}";
      toolCalls = [
        { id: callId, type: "function", function: { name: callName, arguments: callArgs } },
      ];
    }

    // Normalize tool call IDs for provider compatibility
    const normalizedToolCalls =
      toolCalls !== undefined && toolCalls.length > 0
        ? toolCalls.map((tc) => ({
            ...tc,
            id: normalizeToolCallId(tc.id),
          }))
        : undefined;

    // Handle thinking blocks in replay: if the provider requires thinking as
    // plain text, convert thinking metadata to text content prefix.
    const thinkingText = readStringMeta(msg.metadata, "thinking");
    let content = text.length > 0 ? text : null;
    if (thinkingText !== undefined && thinkingText.length > 0 && compat.requiresThinkingAsText) {
      content = thinkingText + (content !== null ? `\n\n${content}` : "");
    }

    return {
      role: "assistant",
      content,
      ...(normalizedToolCalls !== undefined ? { tool_calls: normalizedToolCalls } : {}),
    };
  }

  if (role === "tool") {
    const toolCallId =
      readStringMeta(msg.metadata, "toolCallId") ?? readStringMeta(msg.metadata, "callId");
    const toolName = readStringMeta(msg.metadata, "toolName");
    return {
      role: "tool",
      content: text,
      ...(toolCallId !== undefined ? { tool_call_id: normalizeToolCallId(toolCallId) } : {}),
      ...(compat.requiresToolResultName && toolName !== undefined ? { name: toolName } : {}),
    };
  }

  return { role: "user", content: text };
}

// ---------------------------------------------------------------------------
// Transcript post-processing
// ---------------------------------------------------------------------------

/**
 * Post-process mapped messages to ensure valid Chat Completions transcript.
 *
 * 1. Drops orphaned tool messages (no preceding assistant tool_calls)
 * 2. Inserts bridge assistant messages when provider requires assistant
 *    between tool results and user messages
 */
function fixTranscriptOrdering(
  messages: readonly ChatCompletionMessage[],
  compat: ResolvedCompat,
): readonly ChatCompletionMessage[] {
  const declaredCallIds = new Set<string>();
  const result: ChatCompletionMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const prevRole = result.length > 0 ? result[result.length - 1]?.role : undefined;

    if (msg.role === "assistant" && msg.tool_calls !== undefined) {
      for (const tc of msg.tool_calls) {
        declaredCallIds.add(tc.id);
      }
      result.push(msg);
    } else if (msg.role === "tool") {
      if (msg.tool_call_id !== undefined && declaredCallIds.has(msg.tool_call_id)) {
        result.push(msg);
      }
      // Orphaned tool messages dropped — privileged data, not relabeled
    } else {
      // Insert bridge assistant message if provider requires it
      if (compat.requiresAssistantAfterToolResult && prevRole === "tool" && msg.role === "user") {
        result.push({ role: "assistant", content: "I have processed the tool results." });
      }
      result.push(msg);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Anthropic prompt caching (via OpenRouter)
// ---------------------------------------------------------------------------

/**
 * Add Anthropic-style cache_control to the last user/assistant text content.
 *
 * Only applies when the model ID starts with "anthropic/" — Anthropic is the
 * only provider that uses request-side cache control. OpenAI caching is
 * automatic (no headers needed), Google only reports cache metrics.
 *
 * Mutates the messages array in place for performance (called after mapping).
 */
function maybeAddAnthropicCacheControl(messages: ChatCompletionMessage[], model: string): void {
  if (!model.startsWith("anthropic/")) return;

  // Walk backwards to find the last user/assistant message with text content
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    if (typeof msg.content !== "string" || msg.content.length === 0) continue;

    // Convert string content to array format with cache_control.
    // We mutate via Object.assign to work around readonly types — this is
    // intentional post-processing on our own freshly-created message array.
    Object.assign(msg, {
      content: [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }],
    });
    return;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert Koi InboundMessage[] to OpenAI Chat Completions message array.
 * Preserves message roles, normalizes tool call IDs, fixes transcript ordering.
 * Throws if messages contain non-text content blocks.
 */
export function mapMessages(
  messages: readonly InboundMessage[],
  compat: ResolvedCompat,
): readonly ChatCompletionMessage[] {
  const unsupported = findNonTextBlockKind(messages);
  if (unsupported !== undefined) {
    throw new Error(
      `Request contains "${unsupported}" content blocks but only text is supported. ` +
        "Non-text content would be silently dropped.",
    );
  }

  const mapped = messages.map((msg) => mapOneMessage(msg, compat));
  return fixTranscriptOrdering(mapped, compat);
}

/**
 * Build the complete request body for the Chat Completions API.
 * Uses compat flags to adapt to provider-specific quirks.
 */
export function buildRequestBody(
  request: ModelRequest,
  config: ResolvedConfig,
  tools?: readonly ChatCompletionTool[],
): Record<string, unknown> {
  const messages: ChatCompletionMessage[] = [];

  // System prompt — use developer role for reasoning models if supported
  const systemPrompt = request.metadata?.systemPrompt as string | undefined;
  if (systemPrompt !== undefined) {
    const role = config.compat.supportsDeveloperRole ? "developer" : "system";
    const effectiveModel = request.model ?? config.model;
    // Add cache_control to system prompt for Anthropic models — this is the
    // most cacheable content (identical across all turns in a conversation)
    if (effectiveModel.startsWith("anthropic/")) {
      messages.push({
        role: role as "system",
        content: [
          { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
        ] as unknown as string,
      });
    } else {
      messages.push({ role: role as "system", content: systemPrompt });
    }
  }

  // Conversation messages
  messages.push(...mapMessages(request.messages, config.compat));

  // Anthropic prompt caching — add cache_control to last text block
  const effectiveModel = request.model ?? config.model;
  maybeAddAnthropicCacheControl(messages, effectiveModel);

  const body: Record<string, unknown> = {
    model: request.model ?? config.model,
    messages,
    stream: true,
  };

  // Usage in streaming — conditionally enabled
  if (config.compat.supportsUsageInStreaming) {
    body.stream_options = { include_usage: true };
  }

  // Max tokens — field name varies by provider
  if (request.maxTokens !== undefined) {
    body[config.compat.maxTokensField] = request.maxTokens;
  }

  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }

  // Store — some providers reject this field
  if (config.compat.supportsStore) {
    body.store = false;
  }

  if (tools !== undefined && tools.length > 0) {
    body.tools = tools;
  }

  return body;
}
