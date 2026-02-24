/**
 * vLLM provider adapter.
 *
 * Connects to a local vLLM instance via its OpenAI-compatible API.
 * No authentication required. Implements health checking via /health.
 */

import type { ProviderAdapter } from "../provider-adapter.js";
import { createOpenAICompatibleAdapter } from "./openai-compat.js";

const DEFAULT_BASE_URL = "http://localhost:8000";
const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = 3_000;

export interface VLLMAdapterConfig {
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly healthCheckTimeoutMs?: number | undefined;
}

/**
 * Creates a vLLM provider adapter.
 *
 * Uses the OpenAI-compatible API at `/v1/chat/completions`.
 * No API key required. Implements `checkHealth()` via `GET /health`.
 */
export function createVLLMAdapter(config?: VLLMAdapterConfig): ProviderAdapter {
  const baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
  const healthCheckTimeoutMs = config?.healthCheckTimeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;

  const compat = createOpenAICompatibleAdapter({
    baseUrl: `${baseUrl}/v1`,
    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    headers: config?.headers,
    providerName: "vLLM",
  });

  return {
    id: "vllm",
    complete: compat.complete,
    stream: compat.stream,

    async checkHealth(): Promise<boolean> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), healthCheckTimeoutMs);
      try {
        const response = await fetch(`${baseUrl}/health`, {
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
