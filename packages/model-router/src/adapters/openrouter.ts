/**
 * OpenRouter provider adapter.
 *
 * OpenRouter exposes an OpenAI-compatible API, so we delegate to the shared
 * OpenAI-compatible base adapter with OpenRouter-specific headers.
 */

import type { ProviderAdapter, ProviderAdapterConfig } from "../provider-adapter.js";
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
    stream: compat.stream,
  };
}
