/**
 * LM Studio provider adapter.
 *
 * Connects to a local LM Studio instance via its OpenAI-compatible API.
 * No authentication required. Implements health checking via /v1/models.
 */

import type { ProviderAdapter } from "../provider-adapter.js";
import { createOpenAICompatibleAdapter } from "./openai-compat.js";

const DEFAULT_BASE_URL = "http://localhost:1234";
const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = 3_000;

export interface LMStudioAdapterConfig {
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly healthCheckTimeoutMs?: number | undefined;
}

/**
 * Creates an LM Studio provider adapter.
 *
 * Uses the OpenAI-compatible API at `/v1/chat/completions`.
 * No API key required. Implements `checkHealth()` via `GET /v1/models`.
 */
export function createLMStudioAdapter(config?: LMStudioAdapterConfig): ProviderAdapter {
  const baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
  const healthCheckTimeoutMs = config?.healthCheckTimeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;

  const compat = createOpenAICompatibleAdapter({
    baseUrl: `${baseUrl}/v1`,
    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    headers: config?.headers,
    providerName: "LM Studio",
  });

  return {
    id: "lm-studio",
    complete: compat.complete,
    stream: compat.stream,

    async checkHealth(): Promise<boolean> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), healthCheckTimeoutMs);
      try {
        const response = await fetch(`${baseUrl}/v1/models`, {
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
