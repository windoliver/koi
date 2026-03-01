/**
 * OpenAI-compatible base adapter.
 *
 * Creates a ProviderAdapter that speaks the OpenAI chat completions API format.
 * Used by OpenAI, OpenRouter, and Ollama adapters — each configures provider-specific
 * defaults (base URL, auth, headers) and delegates here.
 */

import type { KoiError, ModelRequest, ModelResponse } from "@koi/core";
import type { ProviderAdapter, StreamChunk } from "../provider-adapter.js";
import { fromOpenAIResponse, toOpenAIRequest } from "./openai.js";
import {
  fetchWithTimeout,
  handleAbortError,
  handleStreamAbortError,
  mapStatusToErrorCode,
  parseRetryAfter,
  parseSSEStream,
  streamFetch,
} from "./shared.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface OpenAICompatibleConfig {
  readonly baseUrl: string;
  readonly timeoutMs?: number | undefined;
  readonly apiKey?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly providerName: string;
  readonly defaultModel?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/**
 * Creates a ProviderAdapter using the OpenAI-compatible chat completions API.
 *
 * Reuses `toOpenAIRequest`/`fromOpenAIResponse` from the OpenAI adapter for
 * request/response transformation. Auth is optional for local providers (Ollama).
 */
export function createOpenAICompatibleAdapter(
  config: OpenAICompatibleConfig,
): Pick<ProviderAdapter, "complete" | "stream"> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
    return { ...headers, ...config.headers };
  }

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const requestWithModel: ModelRequest = config.defaultModel
        ? { ...request, model: request.model ?? config.defaultModel }
        : request;
      const body = toOpenAIRequest(requestWithModel);
      const url = `${config.baseUrl}/chat/completions`;

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
          const retryAfterMs = parseRetryAfter(result.response.headers);
          throw {
            code: mapStatusToErrorCode(result.response.status),
            message: `${config.providerName} API error ${result.response.status}: ${errorBody}`,
            retryable: result.response.status === 429 || result.response.status >= 500,
            ...(retryAfterMs !== undefined && { retryAfterMs }),
            context: { statusCode: result.response.status },
          } satisfies KoiError;
        }

        const json = (await result.response.json()) as Parameters<typeof fromOpenAIResponse>[0];
        return fromOpenAIResponse(json);
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
        throw handleAbortError(error, config.providerName, timeoutMs, request.signal);
      } finally {
        clearTimer?.();
      }
    },

    async *stream(request: ModelRequest): AsyncGenerator<StreamChunk> {
      const requestWithModel: ModelRequest = config.defaultModel
        ? { ...request, model: request.model ?? config.defaultModel }
        : request;
      const body = { ...toOpenAIRequest(requestWithModel), stream: true };
      const url = `${config.baseUrl}/chat/completions`;

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
            message: `${config.providerName} API error ${result.response.status}: ${errorBody}`,
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
            if (data === "[DONE]") {
              return { kind: "finish", reason: "completed" };
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
                return { kind: "text_delta", text: delta };
              }
              const finishReason = parsed.choices[0]?.finish_reason;
              if (finishReason) {
                return { kind: "finish", reason: finishReason };
              }
            } catch {
              // Ignore malformed SSE data
            }
            return undefined;
          },
          result.resetTimer,
        );

        for await (const chunk of chunks) {
          yield chunk;
          // If we yielded a finish from [DONE], stop
          if (chunk.kind === "finish" && chunk.reason === "completed") return;
        }
      } catch (error: unknown) {
        const message = handleStreamAbortError(
          error,
          config.providerName,
          timeoutMs,
          request.signal,
        );
        yield { kind: "error", message };
      } finally {
        clearTimer?.();
      }
    },
  };
}
