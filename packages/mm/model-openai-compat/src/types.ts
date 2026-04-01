/**
 * Configuration and internal types for the OpenRouter model adapter.
 */

import type { ModelCapabilities } from "@koi/core/model-provider";

/**
 * Configuration for creating an OpenRouter-compatible model adapter.
 */
export interface OpenAICompatAdapterConfig {
  /** API key for authentication. */
  readonly apiKey: string;
  /** Provider API base URL. Defaults to OpenRouter. */
  readonly baseUrl?: string | undefined;
  /** Model identifier (e.g., "anthropic/claude-sonnet-4"). */
  readonly model: string;
  /** Override auto-detected capabilities. */
  readonly capabilities?: Partial<ModelCapabilities> | undefined;
  /** Additional HTTP headers for every request. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Provider name for telemetry. Defaults to "openai-compat". */
  readonly provider?: string | undefined;
}

/** Resolved config with defaults applied. */
export interface ResolvedConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  readonly headers: Readonly<Record<string, string>>;
  readonly provider: string;
}

export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  functionCalling: true,
  vision: false,
  jsonMode: false,
  maxContextTokens: 128_000,
  maxOutputTokens: 4096,
};

export function resolveConfig(config: OpenAICompatAdapterConfig): ResolvedConfig {
  const capabilities = { ...DEFAULT_CAPABILITIES, ...config.capabilities };

  // Fail closed: do not advertise capabilities the adapter cannot serve.
  // Multimodal request serialization is not yet implemented.
  if (capabilities.vision) {
    throw new Error(
      "Cannot set vision: true — multimodal request serialization is not yet implemented. " +
        "The adapter would reject image/file content at request time.",
    );
  }

  return {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    model: config.model,
    capabilities,
    headers: config.headers ?? {},
    provider: config.provider ?? "openai-compat",
  };
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions API shapes (minimal subset)
// ---------------------------------------------------------------------------

export interface ChatCompletionMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_calls?: readonly ChatCompletionToolCall[];
  readonly tool_call_id?: string;
}

export interface ChatCompletionToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface ChatCompletionTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  };
}

export interface ChatCompletionChunkDelta {
  readonly content?: string | null;
  readonly reasoning_content?: string | null;
  readonly tool_calls?: readonly ChatCompletionChunkToolCall[];
}

export interface ChatCompletionChunkToolCall {
  readonly index: number;
  readonly id?: string;
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

export interface ChatCompletionChunkChoice {
  readonly index: number;
  readonly delta: ChatCompletionChunkDelta;
  readonly finish_reason: string | null;
}

export interface ChatCompletionChunk {
  readonly id: string;
  readonly choices: readonly ChatCompletionChunkChoice[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  };
}
