/**
 * Configuration and internal types for the OpenAI-compatible model adapter.
 */

import type { ModelCapabilities } from "@koi/core/model-provider";

// ---------------------------------------------------------------------------
// Provider compatibility flags
// ---------------------------------------------------------------------------

/**
 * Compatibility overrides for OpenAI Chat Completions API variants.
 * Auto-detected from baseUrl when not explicitly set.
 *
 * Modeled after pi-ai's OpenAICompletionsCompat, covering the real quirks
 * across OpenRouter, Groq, xAI, Cerebras, z.ai, and other endpoints.
 */
export interface ProviderCompat {
  /** Whether the provider supports `stream_options: { include_usage: true }`. Default: true. */
  readonly supportsUsageInStreaming?: boolean | undefined;
  /** Which field to use for max tokens. Default: "max_completion_tokens". */
  readonly maxTokensField?: "max_completion_tokens" | "max_tokens" | undefined;
  /** Whether the provider supports the `store` field. Default: true. */
  readonly supportsStore?: boolean | undefined;
  /** Whether the provider supports `developer` role (vs `system`) for reasoning models. Default: true. */
  readonly supportsDeveloperRole?: boolean | undefined;
  /** Whether tool results require the `name` field. Default: false. */
  readonly requiresToolResultName?: boolean | undefined;
  /** Whether a user message after tool results requires an assistant message in between. Default: false. */
  readonly requiresAssistantAfterToolResult?: boolean | undefined;
  /** Whether thinking blocks must be converted to text in assistant message replay. Default: false. */
  readonly requiresThinkingAsText?: boolean | undefined;
  /** Whether the provider supports `strict` in tool definitions. Default: true. */
  readonly supportsStrictMode?: boolean | undefined;
}

/** Fully resolved compat with all fields set. */
export interface ResolvedCompat {
  readonly supportsUsageInStreaming: boolean;
  readonly maxTokensField: "max_completion_tokens" | "max_tokens";
  readonly supportsStore: boolean;
  readonly supportsDeveloperRole: boolean;
  readonly requiresToolResultName: boolean;
  readonly requiresAssistantAfterToolResult: boolean;
  readonly requiresThinkingAsText: boolean;
  readonly supportsStrictMode: boolean;
}

const _DEFAULT_COMPAT: ResolvedCompat = {
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens",
  supportsStore: true,
  supportsDeveloperRole: true,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  supportsStrictMode: true,
};

/**
 * Auto-detect compatibility flags from the base URL.
 * Based on known provider quirks from pi-ai's battle-tested compat detection.
 */
function detectCompat(baseUrl: string): ResolvedCompat {
  const isChutes = baseUrl.includes("chutes.ai");
  const isCerebras = baseUrl.includes("cerebras.ai");
  const isXai = baseUrl.includes("api.x.ai");
  const isZai = baseUrl.includes("api.z.ai");
  const isDeepSeek = baseUrl.includes("deepseek.com");
  const isGroq = baseUrl.includes("groq.com");
  const isOpenCode = baseUrl.includes("opencode.ai");

  const isNonStandard = isCerebras || isXai || isChutes || isDeepSeek || isZai || isOpenCode;

  return {
    supportsUsageInStreaming: true,
    maxTokensField: isChutes ? "max_tokens" : "max_completion_tokens",
    supportsStore: !isNonStandard,
    supportsDeveloperRole: !isNonStandard,
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: isGroq || isDeepSeek,
    supportsStrictMode: true,
  };
}

/** Merge explicit overrides with auto-detected compat. */
export function resolveCompat(baseUrl: string, overrides?: ProviderCompat): ResolvedCompat {
  const detected = detectCompat(baseUrl);
  if (overrides === undefined) return detected;
  return {
    supportsUsageInStreaming:
      overrides.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
    maxTokensField: overrides.maxTokensField ?? detected.maxTokensField,
    supportsStore: overrides.supportsStore ?? detected.supportsStore,
    supportsDeveloperRole: overrides.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    requiresToolResultName: overrides.requiresToolResultName ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      overrides.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText: overrides.requiresThinkingAsText ?? detected.requiresThinkingAsText,
    supportsStrictMode: overrides.supportsStrictMode ?? detected.supportsStrictMode,
  };
}

// ---------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for creating an OpenAI-compatible model adapter.
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
  /** Override auto-detected provider compatibility flags. */
  readonly compat?: ProviderCompat | undefined;
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
  readonly compat: ResolvedCompat;
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
  if (capabilities.vision) {
    throw new Error(
      "Cannot set vision: true — multimodal request serialization is not yet implemented. " +
        "The adapter would reject image/file content at request time.",
    );
  }

  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;

  return {
    apiKey: config.apiKey,
    baseUrl,
    model: config.model,
    capabilities,
    compat: resolveCompat(baseUrl, config.compat),
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
  /** Tool result name — required by some providers. */
  readonly name?: string;
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
    readonly strict?: boolean;
  };
}

export interface ChatCompletionChunkDelta {
  readonly content?: string | null;
  /** Anthropic-style reasoning (via OpenRouter, llama.cpp). */
  readonly reasoning_content?: string | null;
  /** Alternative reasoning field (some OpenAI-compat endpoints). */
  readonly reasoning?: string | null;
  /** Alternative reasoning field (llama.cpp variants). */
  readonly reasoning_text?: string | null;
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
