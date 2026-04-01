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

/** Options threaded through message mapping. */
interface MapOptions {
  readonly compat: ResolvedCompat;
  readonly trusted: boolean;
}

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
/**
 * Stateful ID normalizer that detects collisions.
 * Two different source IDs that normalize to the same output would silently
 * corrupt tool-call linkage — this guard fails closed by appending a
 * disambiguating suffix when a collision is detected.
 */
function createIdNormalizer(): (id: string) => string {
  // Maps original source ID → stable normalized output. Same source ID
  // always returns the same normalized value across the transcript.
  const cache = new Map<string, string>();
  // Tracks which normalized values are taken to detect collisions.
  const taken = new Set<string>();

  return (id: string): string => {
    // Fast path: same source ID seen before → return cached result
    const cached = cache.get(id);
    if (cached !== undefined) return cached;

    // Handle pipe-separated IDs — extract just the call_id part
    const base = id.includes("|") ? (id.split("|")[0] ?? id) : id;
    // Sanitize to allowed characters and truncate
    let normalized = base.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);

    // Collision — a different source ID already claimed this normalized value
    if (taken.has(normalized)) {
      let suffix = 1;
      while (taken.has(`${normalized.slice(0, 36)}_c${suffix}`)) {
        suffix++;
      }
      normalized = `${normalized.slice(0, 36)}_c${suffix}`;
    }

    cache.set(id, normalized);
    taken.add(normalized);
    return normalized;
  };
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
 * TRUST BOUNDARY — privilege escalation prevention:
 *
 * System role: ONLY granted via `system:*` senderIds (engine-injected).
 * metadata.role="system" is IGNORED — prevents user-controlled metadata
 * from promoting arbitrary text to system/developer prompt priority.
 *
 * Assistant/tool roles: trusted from metadata.role per L1 convention.
 * These are non-escalating (lower/equal privilege to user). The engine
 * and session-repair set these fields; InboundMessage is not externally
 * constructable. If InboundMessage ever becomes a public input type,
 * assistant/tool metadata MUST be moved to a separate trusted structure
 * to prevent tool-result/history injection.
 *
 * metadata.callId/toolCalls: trusted as L1 engine state (same caveat).
 *
 * Priority:
 * 1. senderId "system:*" → system (engine-only, not overridable)
 * 2. metadata.role for non-escalating roles (assistant, tool, user)
 * 3. senderId heuristic ("assistant", "tool")
 * 4. Default to "user"
 */
function resolveRole(
  msg: InboundMessage,
  trusted: boolean,
): "user" | "assistant" | "tool" | "system" {
  // In untrusted mode, ALL messages are user — senderId and metadata are
  // both caller-controlled and cannot determine privileged roles.
  if (!trusted) return "user";

  // --- Trusted mode only below this line ---

  // Engine-injected control messages (system:loop-detector, system:capabilities)
  if (msg.senderId.startsWith("system:")) return "system";

  // metadata.role for non-escalating roles (L1 engine / session-repair)
  const explicitRole = readStringMeta(msg.metadata, "role");
  if (explicitRole === "assistant" || explicitRole === "tool" || explicitRole === "user") {
    return explicitRole;
  }

  // senderId heuristic fallback
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
function mapOneMessage(
  msg: InboundMessage,
  opts: MapOptions,
  normalizeId: (id: string) => string,
): ChatCompletionMessage {
  const text = extractText(msg);
  const role = resolveRole(msg, opts.trusted);

  if (role === "assistant") {
    // Only read tool-call metadata when trusted (L1 engine). Untrusted callers
    // cannot inject fake tool_calls/callId into the transcript.
    let toolCalls: readonly ChatCompletionToolCall[] | undefined;
    if (opts.trusted) {
      toolCalls = msg.metadata?.toolCalls as readonly ChatCompletionToolCall[] | undefined;

      // Session-repair fallback: reconstruct tool_calls from callId
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
    }

    // Normalize tool call IDs for provider compatibility
    const normalizedToolCalls =
      toolCalls !== undefined && toolCalls.length > 0
        ? toolCalls.map((tc) => ({
            ...tc,
            id: normalizeId(tc.id),
          }))
        : undefined;

    // Handle thinking blocks in replay: if the provider requires thinking as
    // plain text, convert thinking metadata to text content prefix.
    const thinkingText = opts.trusted ? readStringMeta(msg.metadata, "thinking") : undefined;
    let content = text.length > 0 ? text : null;
    if (
      thinkingText !== undefined &&
      thinkingText.length > 0 &&
      opts.compat.requiresThinkingAsText
    ) {
      content = thinkingText + (content !== null ? `\n\n${content}` : "");
    }

    return {
      role: "assistant",
      content,
      ...(normalizedToolCalls !== undefined ? { tool_calls: normalizedToolCalls } : {}),
    };
  }

  if (role === "tool") {
    // Only read tool linkage metadata when trusted
    const toolCallId = opts.trusted
      ? (readStringMeta(msg.metadata, "toolCallId") ?? readStringMeta(msg.metadata, "callId"))
      : undefined;
    const toolName = opts.trusted ? readStringMeta(msg.metadata, "toolName") : undefined;
    return {
      role: "tool",
      content: text,
      ...(toolCallId !== undefined ? { tool_call_id: normalizeId(toolCallId) } : {}),
      ...(opts.compat.requiresToolResultName && toolName !== undefined ? { name: toolName } : {}),
    };
  }

  // Engine-injected system messages (system:loop-detector, system:capabilities)
  // must retain system/developer semantics so guardrails can't be overridden.
  if (role === "system") {
    return { role: "system", content: text };
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
  // Track PENDING call IDs from the most recent assistant tool_calls turn.
  // Tool results must match the current pending set, not any historical call.
  // When a non-tool message arrives, pending IDs are cleared — any unresolved
  // tool results after that point are stale and would be dropped.
  let pendingCallIds = new Set<string>();
  const result: ChatCompletionMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const prevRole = result.length > 0 ? result[result.length - 1]?.role : undefined;

    if (msg.role === "assistant" && msg.tool_calls !== undefined) {
      // New assistant tool_calls turn — replace pending set
      pendingCallIds = new Set(msg.tool_calls.map((tc) => tc.id));
      result.push(msg);
    } else if (msg.role === "tool") {
      if (msg.tool_call_id !== undefined && pendingCallIds.has(msg.tool_call_id)) {
        pendingCallIds.delete(msg.tool_call_id); // Consumed
        result.push(msg);
      }
      // Orphaned/stale tool messages dropped
    } else {
      // Non-tool message clears pending — any unresolved tool results are stale
      pendingCallIds.clear();
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
function maybeAddPromptCacheControl(
  messages: ChatCompletionMessage[],
  model: string,
  compat: ResolvedCompat,
): void {
  // Only emit cache_control when the provider explicitly supports it AND the
  // model is Anthropic. Generic OpenAI-compat endpoints would reject the payload.
  if (!compat.supportsPromptCaching || !model.startsWith("anthropic/")) return;

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
  trusted = false,
): readonly ChatCompletionMessage[] {
  const unsupported = findNonTextBlockKind(messages);
  if (unsupported !== undefined) {
    throw new Error(
      `Request contains "${unsupported}" content blocks but only text is supported. ` +
        "Non-text content would be silently dropped.",
    );
  }

  const opts: MapOptions = { compat, trusted };
  const normalizeId = createIdNormalizer();
  const mapped = messages.map((msg) => mapOneMessage(msg, opts, normalizeId));
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

  // System prompt from the trusted ModelRequest.systemPrompt field (set by L1
  // engine from agent manifest). NOT read from generic metadata to prevent
  // privilege escalation — user-controlled metadata must not become system prompts.
  const systemPrompt = request.systemPrompt;
  if (systemPrompt !== undefined) {
    const role = config.compat.supportsDeveloperRole ? "developer" : "system";
    const effectiveModel = request.model ?? config.model;
    // Add cache_control to system prompt when provider supports prompt caching
    if (config.compat.supportsPromptCaching && effectiveModel.startsWith("anthropic/")) {
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

  // Conversation messages — trusted flag gates metadata.role/toolCalls access
  messages.push(...mapMessages(request.messages, config.compat, config.trustTranscriptMetadata));

  // Prompt caching — gated on compat flag + model prefix
  const effectiveModel = request.model ?? config.model;
  maybeAddPromptCacheControl(messages, effectiveModel, config.compat);

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
