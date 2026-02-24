/**
 * Anthropic provider adapter.
 *
 * Normalizes Anthropic messages API to the ProviderAdapter interface.
 * Uses raw fetch — no SDK dependency.
 */

import type { KoiError, ModelRequest, ModelResponse } from "@koi/core";
import { normalizeToPlainText } from "../normalize.js";
import type { ProviderAdapter, ProviderAdapterConfig, StreamChunk } from "../provider-adapter.js";

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

  return {
    id: "anthropic",

    async complete(request: ModelRequest): Promise<ModelResponse> {
      const body = toAnthropicRequest(request);
      const url = `${baseUrl}/v1/messages`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // Compose caller signal with local timeout controller
      const effectiveSignal =
        request.signal !== undefined
          ? AbortSignal.any([request.signal, controller.signal])
          : controller.signal;

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            ...config.headers,
          },
          body: JSON.stringify(body),
          signal: effectiveSignal,
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          let errorType: string | undefined;
          try {
            const parsed = JSON.parse(errorBody) as { readonly error?: { readonly type?: string } };
            errorType = parsed.error?.type;
          } catch {
            // ignore parse error
          }

          const retryAfterStr = response.headers.get("retry-after");
          const retryAfterMs = retryAfterStr
            ? Math.ceil(Number.parseFloat(retryAfterStr) * 1000)
            : undefined;

          const retryAfterValue =
            retryAfterMs && !Number.isNaN(retryAfterMs) ? retryAfterMs : undefined;
          throw {
            code: mapAnthropicError(response.status, errorType),
            message: `Anthropic API error ${response.status}: ${errorBody}`,
            retryable: response.status === 429 || response.status === 529 || response.status >= 500,
            ...(retryAfterValue !== undefined && { retryAfterMs: retryAfterValue }),
            context: { statusCode: response.status, errorType },
          } satisfies KoiError;
        }

        const json = (await response.json()) as AnthropicResponse;
        return fromAnthropicResponse(json);
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          const isCallerAbort = request.signal?.aborted === true;
          throw {
            code: isCallerAbort ? "EXTERNAL" : "TIMEOUT",
            message: isCallerAbort
              ? "Anthropic request cancelled"
              : `Anthropic request timed out after ${timeoutMs}ms`,
            retryable: !isCallerAbort,
          } satisfies KoiError;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },

    async *stream(request: ModelRequest): AsyncGenerator<StreamChunk> {
      const body = { ...toAnthropicRequest(request), stream: true };
      const url = `${baseUrl}/v1/messages`;

      const controller = new AbortController();
      // Idle timeout: resets on each chunk so long-running healthy streams aren't killed
      let timer = setTimeout(() => controller.abort(), timeoutMs);
      const resetTimer = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), timeoutMs);
      };
      // Compose caller signal with local timeout controller
      const effectiveSignal =
        request.signal !== undefined
          ? AbortSignal.any([request.signal, controller.signal])
          : controller.signal;

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            ...config.headers,
          },
          body: JSON.stringify(body),
          signal: effectiveSignal,
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          yield {
            kind: "error",
            message: `Anthropic API error ${response.status}: ${errorBody}`,
            statusCode: response.status,
          };
          return;
        }

        if (!response.body) {
          yield { kind: "error", message: "No response body for streaming" };
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          resetTimer();
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);

            try {
              const event = JSON.parse(data) as {
                readonly type: string;
                readonly delta?: { readonly type?: string; readonly text?: string };
                readonly usage?: AnthropicUsage;
              };

              if (event.type === "content_block_delta" && event.delta?.text) {
                yield { kind: "text_delta", text: event.delta.text };
              } else if (event.type === "message_delta") {
                yield { kind: "finish", reason: "completed" };
              } else if (event.type === "message_start" && event.usage) {
                // message_start contains initial usage (input tokens)
              }
            } catch {
              // Ignore malformed SSE data
            }
          }
        }
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          const isCallerAbort = request.signal?.aborted === true;
          yield {
            kind: "error",
            message: isCallerAbort
              ? "Anthropic stream cancelled"
              : `Anthropic stream idle timeout after ${timeoutMs}ms`,
          };
        } else {
          yield {
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
