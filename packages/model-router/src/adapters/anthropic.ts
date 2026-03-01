/**
 * Anthropic provider adapter.
 *
 * Normalizes Anthropic messages API to the ProviderAdapter interface.
 * Uses raw fetch — no SDK dependency.
 */

import type { KoiError, ModelRequest, ModelResponse } from "@koi/core";
import { normalizeToPlainText } from "../normalize.js";
import type { ProviderAdapter, ProviderAdapterConfig, StreamChunk } from "../provider-adapter.js";
import {
  fetchWithTimeout,
  handleAbortError,
  handleStreamAbortError,
  parseRetryAfter,
  parseSSEStream,
  streamFetch,
} from "./shared.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

interface AnthropicRequest {
  readonly model: string;
  readonly messages: readonly AnthropicMessage[];
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

/**
 * Transforms a Koi ModelRequest into an Anthropic messages API request.
 */
export function toAnthropicRequest(request: ModelRequest): AnthropicRequest {
  const messages: AnthropicMessage[] = request.messages.map((m) => ({
    role: "user" as const,
    content: normalizeToPlainText(m.content),
  }));

  return {
    model: request.model ?? "claude-sonnet-4-5-20250929",
    messages,
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
