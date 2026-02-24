/**
 * OpenAI provider adapter.
 *
 * Normalizes OpenAI chat completion API to the ProviderAdapter interface.
 * Uses raw fetch — no SDK dependency.
 */

import type { KoiError, ModelRequest, ModelResponse } from "@koi/core";
import { normalizeToPlainText } from "../normalize.js";
import type { ProviderAdapter, ProviderAdapterConfig, StreamChunk } from "../provider-adapter.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

interface OpenAIChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface OpenAIChatRequest {
  readonly model: string;
  readonly messages: readonly OpenAIChatMessage[];
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly stream?: boolean;
}

interface OpenAIUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

interface OpenAIChatResponse {
  readonly id: string;
  readonly model: string;
  readonly choices: readonly {
    readonly message: {
      readonly role: string;
      readonly content: string | null;
    };
    readonly finish_reason: string;
  }[];
  readonly usage?: OpenAIUsage;
}

/**
 * Transforms a Koi ModelRequest into an OpenAI chat completion request.
 */
export function toOpenAIRequest(request: ModelRequest): OpenAIChatRequest {
  const messages: OpenAIChatMessage[] = request.messages.map((m) => ({
    role: "user" as const,
    content: normalizeToPlainText(m.content),
  }));

  return {
    model: request.model ?? "gpt-4o",
    messages,
    ...(request.temperature !== undefined && { temperature: request.temperature }),
    ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
  };
}

/**
 * Transforms an OpenAI chat completion response into a Koi ModelResponse.
 */
export function fromOpenAIResponse(response: OpenAIChatResponse): ModelResponse {
  const content = response.choices[0]?.message.content ?? "";

  return {
    content,
    model: response.model,
    ...(response.usage && {
      usage: {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      },
    }),
  };
}

/**
 * Maps an HTTP status code to a KoiErrorCode.
 */
export function mapStatusToErrorCode(status: number): KoiError["code"] {
  if (status === 401 || status === 403) return "PERMISSION";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMIT";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status >= 500) return "EXTERNAL";
  return "EXTERNAL";
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
 * Creates an OpenAI provider adapter.
 */
export function createOpenAIAdapter(config: ProviderAdapterConfig): ProviderAdapter {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    id: "openai",

    async complete(request: ModelRequest): Promise<ModelResponse> {
      const body = toOpenAIRequest(request);
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
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
            ...config.headers,
          },
          body: JSON.stringify(body),
          signal: effectiveSignal,
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          const retryAfterMs = parseRetryAfter(response.headers);
          throw {
            code: mapStatusToErrorCode(response.status),
            message: `OpenAI API error ${response.status}: ${errorBody}`,
            retryable: response.status === 429 || response.status >= 500,
            ...(retryAfterMs !== undefined && { retryAfterMs }),
            context: { statusCode: response.status },
          } satisfies KoiError;
        }

        const json = (await response.json()) as OpenAIChatResponse;
        return fromOpenAIResponse(json);
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          // Discriminate caller-initiated cancel from internal timeout
          const isCallerAbort = request.signal?.aborted === true;
          throw {
            code: isCallerAbort ? "EXTERNAL" : "TIMEOUT",
            message: isCallerAbort
              ? "OpenAI request cancelled"
              : `OpenAI request timed out after ${timeoutMs}ms`,
            retryable: !isCallerAbort,
          } satisfies KoiError;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },

    async *stream(request: ModelRequest): AsyncGenerator<StreamChunk> {
      const body = { ...toOpenAIRequest(request), stream: true };
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
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
            ...config.headers,
          },
          body: JSON.stringify(body),
          signal: effectiveSignal,
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          yield {
            kind: "error",
            message: `OpenAI API error ${response.status}: ${errorBody}`,
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
              ? "OpenAI stream cancelled"
              : `OpenAI stream idle timeout after ${timeoutMs}ms`,
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
