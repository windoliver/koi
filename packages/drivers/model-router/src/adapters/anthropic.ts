/**
 * Anthropic provider adapter.
 *
 * Normalizes Anthropic messages API to the ProviderAdapter interface.
 * Uses raw fetch — no SDK dependency.
 */

import type { ContentBlock, JsonObject, KoiError, ModelRequest, ModelResponse } from "@koi/core";
import type { NormalizedRole } from "../normalize.js";
import { normalizeMessages, normalizeToPlainText } from "../normalize.js";
import type { ProviderAdapter, ProviderAdapterConfig, StreamChunk } from "../provider-adapter.js";
import {
  fetchWithTimeout,
  handleAbortError,
  handleStreamAbortError,
  parseRetryAfter,
  parseSSEStream,
  streamFetch,
} from "./shared.js";

/** Cache hints written by @koi/middleware-prompt-cache into request.metadata. */
interface CacheHints {
  readonly provider: string;
  readonly lastStableIndex: number;
  readonly staticPrefixTokens: number;
}

/** Well-known metadata key written by @koi/middleware-prompt-cache. */
const CACHE_HINTS_KEY = "__koi_cache_hints__";

/** Read cache hints from request metadata (survives object spread cloning). */
function readCacheHints(metadata: JsonObject | undefined): CacheHints | undefined {
  if (metadata === undefined) return undefined;
  const raw = metadata[CACHE_HINTS_KEY];
  if (raw === undefined || typeof raw !== "object" || raw === null) return undefined;
  return raw as unknown as CacheHints;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const ANTHROPIC_VERSION = "2023-06-01";

// ---------------------------------------------------------------------------
// Anthropic structured content types
// ---------------------------------------------------------------------------

interface AnthropicTextPart {
  readonly type: "text";
  readonly text: string;
}

interface AnthropicImagePart {
  readonly type: "image";
  readonly source:
    | { readonly type: "base64"; readonly media_type: string; readonly data: string }
    | { readonly type: "url"; readonly url: string };
}

type AnthropicContentPart = AnthropicTextPart | AnthropicImagePart;

interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly AnthropicContentPart[];
}

/** Anthropic system content block with optional cache_control. */
interface AnthropicSystemBlock {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: { readonly type: "ephemeral" };
}

interface AnthropicRequest {
  readonly model: string;
  readonly messages: readonly AnthropicMessage[];
  /** System prompt — string for plain text, array for structured with cache_control. */
  readonly system?: string | readonly AnthropicSystemBlock[];
  readonly max_tokens: number;
  readonly temperature?: number;
  readonly stream?: boolean;
}

interface AnthropicUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

interface AnthropicResponse {
  readonly id: string;
  readonly model: string;
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly stop_reason: string;
  readonly usage: AnthropicUsage;
}

// ---------------------------------------------------------------------------
// Content block conversion
// ---------------------------------------------------------------------------

/**
 * Parses a data URL into base64 data and media type.
 * Returns undefined if the URL is not a valid data URL.
 */
function parseDataUrl(
  url: string,
): { readonly data: string; readonly mediaType: string } | undefined {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return { mediaType: match[1], data: match[2] };
  }
  return undefined;
}

/**
 * Converts a single Koi ContentBlock to an Anthropic content part.
 * Text and image blocks map natively; unsupported types fall back to text.
 */
function contentBlockToAnthropicPart(block: ContentBlock): AnthropicContentPart {
  switch (block.kind) {
    case "text":
      return { type: "text", text: block.text };
    case "image": {
      const parsed = parseDataUrl(block.url);
      if (parsed !== undefined) {
        return {
          type: "image",
          source: { type: "base64", media_type: parsed.mediaType, data: parsed.data },
        };
      }
      return { type: "image", source: { type: "url", url: block.url } };
    }
    default:
      // file, button, custom → fall back to plain text representation
      return { type: "text", text: normalizeToPlainText([block]) };
  }
}

/**
 * Converts Koi ContentBlock[] to Anthropic message content.
 * Returns a plain string when all blocks are text (simpler API payload);
 * returns a structured array when images are present.
 */
function contentBlocksToAnthropic(
  content: readonly ContentBlock[],
): string | readonly AnthropicContentPart[] {
  const hasNonText = content.some((b) => b.kind === "image");
  if (!hasNonText) {
    return normalizeToPlainText(content);
  }
  return content.map(contentBlockToAnthropicPart);
}

/**
 * Maps a NormalizedRole to an Anthropic message role.
 * Anthropic does not support "system" as a message role — system messages
 * are separated into the top-level `system` parameter by `toAnthropicRequest`.
 * This function only maps non-system roles.
 */
function mapRoleToAnthropic(role: NormalizedRole): "user" | "assistant" {
  if (role === "assistant") return "assistant";
  // "user" and "system" (for any system messages not extracted) → "user"
  return "user";
}

/**
 * Transforms a Koi ModelRequest into an Anthropic messages API request.
 * Preserves original message roles and rich content (images).
 * System messages are extracted to the top-level `system` parameter.
 */
export function toAnthropicRequest(request: ModelRequest): AnthropicRequest {
  const normalized = normalizeMessages(request.messages);

  // Extract system messages into the top-level system parameter
  const systemTexts = normalized
    .filter((m) => m.role === "system")
    .map((m) => normalizeToPlainText(m.content));
  const systemPrompt = systemTexts.join("\n\n");

  // Non-system messages preserve their roles and rich content
  const messages: readonly AnthropicMessage[] = normalized
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: mapRoleToAnthropic(m.role),
      content: contentBlocksToAnthropic(m.content),
    }));

  // Check for prompt cache hints from middleware metadata
  const cacheHints = readCacheHints(request.metadata);

  // Apply cache_control to the system parameter when hints are present
  let systemParam: string | readonly AnthropicSystemBlock[] | undefined;
  if (systemPrompt.length > 0) {
    if (cacheHints !== undefined) {
      // Use structured system blocks with cache_control on the last block
      systemParam = [
        {
          type: "text" as const,
          text: systemPrompt,
          cache_control: { type: "ephemeral" as const },
        },
      ];
    } else {
      systemParam = systemPrompt;
    }
  }

  return {
    model: request.model ?? "claude-sonnet-4-5-20250929",
    messages,
    ...(systemParam !== undefined && { system: systemParam }),
    max_tokens: request.maxTokens ?? 4096,
    ...(request.temperature !== undefined && { temperature: request.temperature }),
  };
}

/**
 * Transforms an Anthropic response into a Koi ModelResponse.
 */
export function fromAnthropicResponse(response: AnthropicResponse): ModelResponse {
  const content = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  return {
    content,
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

/**
 * Maps Anthropic error types to KoiErrorCode.
 */
export function mapAnthropicError(status: number, errorType?: string): KoiError["code"] {
  if (status === 401) return "PERMISSION";
  if (status === 404) return "NOT_FOUND";
  if (status === 429 || errorType === "rate_limit_error") return "RATE_LIMIT";
  if (status === 529 || errorType === "overloaded_error") return "RATE_LIMIT";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status >= 500) return "EXTERNAL";
  return "EXTERNAL";
}

/**
 * Creates an Anthropic provider adapter.
 */
export function createAnthropicAdapter(config: ProviderAdapterConfig): ProviderAdapter {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(config.apiKey !== undefined ? { "x-api-key": config.apiKey } : {}),
      "anthropic-version": ANTHROPIC_VERSION,
      ...config.headers,
    };
  }

  return {
    id: "anthropic",

    async complete(request: ModelRequest): Promise<ModelResponse> {
      const body = toAnthropicRequest(request);
      const url = `${baseUrl}/v1/messages`;

      let clearTimer: (() => void) | undefined;
      try {
        const result = await fetchWithTimeout({
          url,
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify(body),
          timeoutMs,
          signal: request.signal,
          fetch: config.fetch,
        });
        clearTimer = result.clearTimer;

        if (!result.response.ok) {
          const errorBody = await result.response.text().catch(() => "");
          let errorType: string | undefined;
          try {
            const parsed = JSON.parse(errorBody) as {
              readonly error?: { readonly type?: string };
            };
            errorType = parsed.error?.type;
          } catch {
            // ignore parse error
          }

          const retryAfterMs = parseRetryAfter(result.response.headers);
          const retryAfterValue =
            retryAfterMs !== undefined && !Number.isNaN(retryAfterMs) ? retryAfterMs : undefined;

          throw {
            code: mapAnthropicError(result.response.status, errorType),
            message: `Anthropic API error ${result.response.status}: ${errorBody}`,
            retryable:
              result.response.status === 429 ||
              result.response.status === 529 ||
              result.response.status >= 500,
            ...(retryAfterValue !== undefined && { retryAfterMs: retryAfterValue }),
            context: { statusCode: result.response.status, errorType },
          } satisfies KoiError;
        }

        const json = (await result.response.json()) as AnthropicResponse;
        return fromAnthropicResponse(json);
      } catch (error: unknown) {
        // KoiError objects thrown above should pass through
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          "message" in error &&
          "retryable" in error
        ) {
          throw error;
        }
        throw handleAbortError(error, "Anthropic", timeoutMs, request.signal);
      } finally {
        clearTimer?.();
      }
    },

    async *stream(request: ModelRequest): AsyncGenerator<StreamChunk> {
      const body = { ...toAnthropicRequest(request), stream: true };
      const url = `${baseUrl}/v1/messages`;

      let clearTimer: (() => void) | undefined;
      try {
        const result = await streamFetch({
          url,
          headers: buildHeaders(),
          body: JSON.stringify(body),
          timeoutMs,
          signal: request.signal,
          fetch: config.fetch,
        });
        clearTimer = result.clearTimer;

        if (!result.response.ok) {
          const errorBody = await result.response.text().catch(() => "");
          yield {
            kind: "error",
            message: `Anthropic API error ${result.response.status}: ${errorBody}`,
            statusCode: result.response.status,
          };
          return;
        }

        if (!result.response.body) {
          yield { kind: "error", message: "No response body for streaming" };
          return;
        }

        const chunks = parseSSEStream<StreamChunk>(
          result.response.body,
          (data) => {
            try {
              const event = JSON.parse(data) as {
                readonly type: string;
                readonly delta?: { readonly type?: string; readonly text?: string };
                readonly usage?: AnthropicUsage;
              };

              if (event.type === "content_block_delta" && event.delta?.text) {
                return { kind: "text_delta", text: event.delta.text };
              }
              if (event.type === "message_delta") {
                return { kind: "finish", reason: "completed" };
              }
              // message_start contains initial usage (input tokens) — no chunk emitted
            } catch {
              // Ignore malformed SSE data
            }
            return undefined;
          },
          result.resetTimer,
        );

        for await (const chunk of chunks) {
          yield chunk;
        }
      } catch (error: unknown) {
        const message = handleStreamAbortError(error, "Anthropic", timeoutMs, request.signal);
        yield { kind: "error", message };
      } finally {
        clearTimer?.();
      }
    },
  };
}
