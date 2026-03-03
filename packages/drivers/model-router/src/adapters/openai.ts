/**
 * OpenAI provider adapter.
 *
 * Normalizes OpenAI chat completion API to the ProviderAdapter interface.
 * Uses raw fetch — no SDK dependency.
 */

import type { ModelRequest, ModelResponse } from "@koi/core";
import { normalizeToPlainText } from "../normalize.js";
import type { ProviderAdapter, ProviderAdapterConfig } from "../provider-adapter.js";
import { createOpenAICompatibleAdapter } from "./openai-compat.js";

// Re-export shared mapStatusToErrorCode for backward compatibility
export { mapStatusToErrorCode } from "./shared.js";

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
 * Creates an OpenAI provider adapter.
 *
 * Delegates to the shared OpenAI-compatible base adapter with OpenAI-specific defaults.
 */
export function createOpenAIAdapter(config: ProviderAdapterConfig): ProviderAdapter {
  const compat = createOpenAICompatibleAdapter({
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    apiKey: config.apiKey,
    headers: config.headers,
    providerName: "OpenAI",
    defaultModel: "gpt-4o",
  });

  return {
    id: "openai",
    complete: compat.complete,
    stream: compat.stream,
  };
}
