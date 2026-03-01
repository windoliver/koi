/**
 * Provider adapter interface for multi-provider LLM routing.
 *
 * Each provider (OpenAI, Anthropic, etc.) implements this interface
 * to normalize request/response formats.
 */

import type { JsonObject, ModelRequest, ModelResponse } from "@koi/core";

export interface ProviderAdapterConfig {
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export type StreamChunk =
  | { readonly kind: "text_delta"; readonly text: string }
  | {
      readonly kind: "tool_call";
      readonly toolName: string;
      readonly callId: string;
      readonly args: JsonObject;
    }
  | { readonly kind: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: "finish"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string; readonly statusCode?: number };

export interface ProviderAdapter {
  readonly id: string;
  readonly complete: (request: ModelRequest) => Promise<ModelResponse>;
  readonly stream: (request: ModelRequest) => AsyncGenerator<StreamChunk>;
  readonly checkHealth?: () => Promise<boolean>;
}
