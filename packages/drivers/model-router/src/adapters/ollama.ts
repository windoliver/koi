/**
 * Ollama provider adapter.
 *
 * Connects to a local Ollama instance via its OpenAI-compatible API.
 * No authentication required. Implements health checking via /api/tags.
 */

import type { ProviderAdapter } from "../provider-adapter.js";
import { createOpenAICompatibleAdapter } from "./openai-compat.js";

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = 3_000;

export interface OllamaAdapterConfig {
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly healthCheckTimeoutMs?: number | undefined;
}

/**
 * Creates an Ollama provider adapter.
 *
 * Uses the OpenAI-compatible API at `/v1/chat/completions`.
 * No API key required. Implements `checkHealth()` via `GET /api/tags`.
 */
export function createOllamaAdapter(config?: OllamaAdapterConfig): ProviderAdapter {
  const baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
  const healthCheckTimeoutMs = config?.healthCheckTimeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;

  const compat = createOpenAICompatibleAdapter({
    baseUrl: `${baseUrl}/v1`,
    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    headers: config?.headers,
    providerName: "Ollama",
  });

  return {
    id: "ollama",
    complete: compat.complete,
    stream: compat.stream,

    async checkHealth(): Promise<boolean> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), healthCheckTimeoutMs);
      try {
        const response = await fetch(`${baseUrl}/api/tags`, {
          signal: controller.signal,
        });
        return response.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
