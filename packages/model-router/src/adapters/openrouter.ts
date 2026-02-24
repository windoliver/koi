/**
 * OpenRouter provider adapter.
 *
 * OpenRouter exposes an OpenAI-compatible API, so we reuse the OpenAI
 * request/response transforms. Only the auth headers and base URL differ.
 */

import type { KoiError, ModelRequest, ModelResponse } from "@koi/core";
import type { ProviderAdapter, ProviderAdapterConfig, StreamChunk } from "../provider-adapter.js";
import { fromOpenAIResponse, mapStatusToErrorCode, toOpenAIRequest } from "./openai.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = "openai/gpt-4o";

export interface OpenRouterAdapterConfig extends ProviderAdapterConfig {
  /** Sent as `HTTP-Referer` — OpenRouter uses this for app ranking/analytics. */
  readonly referer?: string | undefined;
  /** Sent as `X-Title` — human-readable app name shown on openrouter.ai. */
  readonly appName?: string | undefined;
}

/**
 * Builds the header map for an OpenRouter request.
 */
function buildHeaders(config: OpenRouterAdapterConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };

  if (config.referer) {
    headers["HTTP-Referer"] = config.referer;
  }
  if (config.appName) {
    headers["X-Title"] = config.appName;
  }

  return { ...headers, ...config.headers };
}

/**
 * Extracts Retry-After header value as milliseconds.
 */
function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number.parseFloat(value);
  if (Number.isNaN(seconds)) return undefined;
  return Math.ceil(seconds * 1000);
}

/**
 * Creates an OpenRouter provider adapter.
 *
 * OpenRouter is OpenAI-compatible, so this adapter delegates request/response
 * transformation to the shared OpenAI helpers and adds OpenRouter-specific
 * headers (`HTTP-Referer`, `X-Title`).
 */
export function createOpenRouterAdapter(config: OpenRouterAdapterConfig): ProviderAdapter {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    id: "openrouter",

    async complete(request: ModelRequest): Promise<ModelResponse> {
      const requestWithModel: ModelRequest = {
        ...request,
        model: request.model ?? DEFAULT_MODEL,
      };
      const body = toOpenAIRequest(requestWithModel);
      const url = `${baseUrl}/chat/completions`;

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
          headers: buildHeaders(config),
          body: JSON.stringify(body),
          signal: effectiveSignal,
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          const retryAfterMs = parseRetryAfter(response.headers);
          throw {
            code: mapStatusToErrorCode(response.status),
            message: `OpenRouter API error ${response.status}: ${errorBody}`,
            retryable: response.status === 429 || response.status >= 500,
            ...(retryAfterMs !== undefined && { retryAfterMs }),
            context: { statusCode: response.status },
          } satisfies KoiError;
        }

        const json = (await response.json()) as Parameters<typeof fromOpenAIResponse>[0];
        return fromOpenAIResponse(json);
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          const isCallerAbort = request.signal?.aborted === true;
          throw {
            code: isCallerAbort ? "EXTERNAL" : "TIMEOUT",
            message: isCallerAbort
              ? "OpenRouter request cancelled"
              : `OpenRouter request timed out after ${timeoutMs}ms`,
            retryable: !isCallerAbort,
          } satisfies KoiError;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },

    async *stream(request: ModelRequest): AsyncGenerator<StreamChunk> {
      const requestWithModel: ModelRequest = {
        ...request,
        model: request.model ?? DEFAULT_MODEL,
      };
      const body = { ...toOpenAIRequest(requestWithModel), stream: true };
      const url = `${baseUrl}/chat/completions`;

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
          headers: buildHeaders(config),
          body: JSON.stringify(body),
          signal: effectiveSignal,
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          yield {
            kind: "error",
            message: `OpenRouter API error ${response.status}: ${errorBody}`,
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
            if (data === "[DONE]") {
              yield { kind: "finish", reason: "completed" };
              return;
            }

            try {
              const parsed = JSON.parse(data) as {
                readonly choices: readonly {
                  readonly delta: { readonly content?: string };
                  readonly finish_reason?: string | null;
                }[];
              };
              const delta = parsed.choices[0]?.delta.content;
              if (delta) {
                yield { kind: "text_delta", text: delta };
              }
              if (parsed.choices[0]?.finish_reason) {
                yield { kind: "finish", reason: parsed.choices[0].finish_reason };
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
              ? "OpenRouter stream cancelled"
              : `OpenRouter stream idle timeout after ${timeoutMs}ms`,
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
