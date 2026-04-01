/**
 * OpenRouter provider adapter.
 *
 * OpenRouter exposes an OpenAI-compatible API, so we delegate to the shared
 * OpenAI-compatible base adapter with OpenRouter-specific headers.
 */

import type { JsonObject, ModelRequest } from "@koi/core";
import type { ProviderAdapter, ProviderAdapterConfig } from "../provider-adapter.js";
import { toOpenAIRequest } from "./openai.js";
import { createOpenAICompatibleAdapter } from "./openai-compat.js";

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
 * Builds the extra header map for OpenRouter requests.
 */
function buildOpenRouterHeaders(config: OpenRouterAdapterConfig): Record<string, string> {
  const headers: Record<string, string> = {};

  if (config.referer) {
    headers["HTTP-Referer"] = config.referer;
  }
  if (config.appName) {
    headers["X-Title"] = config.appName;
  }

  return { ...headers, ...config.headers };
}

/**
 * Creates an OpenRouter provider adapter.
 *
 * Delegates to the shared OpenAI-compatible base adapter with
 * OpenRouter-specific headers (`HTTP-Referer`, `X-Title`).
 */
export function createOpenRouterAdapter(config: OpenRouterAdapterConfig): ProviderAdapter {
  const compat = createOpenAICompatibleAdapter({
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    apiKey: config.apiKey,
    headers: buildOpenRouterHeaders(config),
    providerName: "OpenRouter",
    defaultModel: DEFAULT_MODEL,
  });

  return {
    id: "openrouter",
    complete: compat.complete,
    // Streaming uses a fetch+parse approach: the OpenAI-compat SSE streaming
    // parser does not handle delta.tool_calls, causing tool-use responses to
    // silently fail. Instead, make a non-streaming request, parse the full
    // OpenAI response (including tool_calls), and emit as StreamChunks.
    async *stream(request) {
      const requestWithModel: ModelRequest = { ...request, model: request.model ?? DEFAULT_MODEL };
      const body = toOpenAIRequest(requestWithModel);
      const url = `${config.baseUrl ?? DEFAULT_BASE_URL}/chat/completions`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...buildOpenRouterHeaders(config),
      };
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        yield {
          kind: "error" as const,
          message: `OpenRouter API error ${res.status}: ${errorBody}`,
          statusCode: res.status,
        };
        return;
      }

      const json = (await res.json()) as {
        readonly model: string;
        readonly choices: readonly {
          readonly message: {
            readonly content?: string | null;
            readonly tool_calls?: readonly {
              readonly id: string;
              readonly function: { readonly name: string; readonly arguments: string };
            }[];
          };
          readonly finish_reason?: string | null;
        }[];
        readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number };
      };

      const choice = json.choices[0];
      if (choice === undefined) {
        yield { kind: "error" as const, message: "OpenRouter: empty choices array" };
        return;
      }

      // Emit text content
      if (choice.message.content) {
        yield { kind: "text_delta" as const, text: choice.message.content };
      }

      // Emit tool calls
      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          let args: JsonObject = {};
          try {
            args = JSON.parse(tc.function.arguments) as JsonObject;
          } catch {
            /* empty */
          }
          yield {
            kind: "tool_call" as const,
            toolName: tc.function.name,
            callId: tc.id,
            args,
          };
        }
      }

      // Emit usage
      if (json.usage) {
        yield {
          kind: "usage" as const,
          inputTokens: json.usage.prompt_tokens,
          outputTokens: json.usage.completion_tokens,
        };
      }

      yield { kind: "finish" as const, reason: choice.finish_reason ?? "stop" };
    },
  };
}
