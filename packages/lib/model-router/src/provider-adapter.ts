/**
 * Provider adapter interface for multi-provider LLM routing.
 *
 * Each LLM provider (Anthropic, OpenAI, Ollama, etc.) implements this interface
 * to plug into the model router. Concrete implementations live in separate L2 packages.
 */

import type { ModelChunk, ModelRequest, ModelResponse } from "@koi/core";

export interface ProviderAdapterConfig {
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly complete: (request: ModelRequest) => Promise<ModelResponse>;
  readonly stream: (request: ModelRequest) => AsyncGenerator<ModelChunk>;
  /**
   * Optional health check. Only called for local providers (localhost/127.0.0.1).
   * Returns true if the provider is healthy.
   */
  readonly checkHealth?: () => Promise<boolean>;
}
