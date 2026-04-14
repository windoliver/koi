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
  /** Whether the provider supports Anthropic-style prompt caching via cache_control. Default: false (opt-in). */
  readonly supportsPromptCaching?: boolean | undefined;
  /**
   * Whether the provider supports the `reasoning` request field for extended
   * thinking (OpenRouter). When true, `buildRequestBody` includes
   * `reasoning: { effort }` so models that support it return reasoning tokens
   * as `reasoning_content` in the SSE stream. Default: false.
   *
   * OpenRouter ignores this field for models without reasoning capability,
   * so it's safe to enable broadly for the provider.
   */
  readonly supportsReasoning?: boolean | undefined;
  /**
   * Default reasoning effort level. Only used when `supportsReasoning` is true.
   * Maps to OpenRouter's `reasoning.effort` values: "low" | "medium" | "high".
   * Default: "medium".
   */
  readonly defaultReasoningEffort?: "low" | "medium" | "high" | undefined;
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
  readonly supportsPromptCaching: boolean;
  readonly supportsReasoning: boolean;
  readonly defaultReasoningEffort: "low" | "medium" | "high";
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
  supportsPromptCaching: false,
  supportsReasoning: false,
  defaultReasoningEffort: "medium",
};

/**
 * Auto-detect compatibility flags from the base URL.
 * Based on known provider quirks from pi-ai's battle-tested compat detection.
 */
function detectCompat(baseUrl: string): ResolvedCompat {
  const isChutes = baseUrl.includes("chutes.ai");
  const isCerebras = baseUrl.includes("cerebras.ai");
  const isXai = baseUrl.includes("api.x.ai");
  const _isZai = baseUrl.includes("api.z.ai");
  const isDeepSeek = baseUrl.includes("deepseek.com");
  const isGroq = baseUrl.includes("groq.com");
  const _isOpenCode = baseUrl.includes("opencode.ai");
  const isOpenRouter = baseUrl.includes("openrouter.ai");
  const isOpenAI = baseUrl.includes("api.openai.com");

  // Known providers that support extended OpenAI features
  const isFullyCompatible = isOpenRouter || isOpenAI;

  return {
    // Fail-closed for unknown providers: only emit fields that the core
    // Chat Completions spec guarantees. Optional fields (store, developer
    // role, stream_options) are enabled only for known providers. Generic
    // proxies often reject unrecognized fields with HTTP 400.
    supportsUsageInStreaming: isFullyCompatible || isGroq || isCerebras || isXai,
    maxTokensField: isChutes ? "max_tokens" : "max_completion_tokens",
    supportsStore: isFullyCompatible,
    supportsDeveloperRole: isFullyCompatible,
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: isGroq || isDeepSeek,
    supportsStrictMode: isFullyCompatible,
    supportsPromptCaching: isOpenRouter,
    // Reasoning is NOT auto-detected — callers must opt in via ProviderCompat
    // override. Auto-enabling for all OpenRouter traffic would change the wire
    // contract for non-reasoning models, increase latency/cost, and risk 400s.
    supportsReasoning: false,
    defaultReasoningEffort: "medium",
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
    supportsPromptCaching: overrides.supportsPromptCaching ?? detected.supportsPromptCaching,
    supportsReasoning: overrides.supportsReasoning ?? detected.supportsReasoning,
    defaultReasoningEffort: overrides.defaultReasoningEffort ?? detected.defaultReasoningEffort,
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
  /** Override retry configuration. Set maxRetries: 0 to disable retry. */
  readonly retry?:
    | {
        readonly maxRetries?: number | undefined;
        readonly baseDelayMs?: number | undefined;
        readonly maxDelayMs?: number | undefined;
      }
    | undefined;
  /**
   * Trust message metadata for transcript replay (role, toolCalls, callId).
   *
   * Default: true — this adapter is designed for L1 engine use where
   * InboundMessage is constructed internally. When true, metadata.role,
   * toolCalls, and callId are honored for session-repair/tool-replay.
   * Set to false when exposing the adapter to untrusted external callers
   * that could inject fake assistant/tool turns via metadata.
   */
  readonly trustTranscriptMetadata?: boolean | undefined;
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
  readonly trustTranscriptMetadata: boolean;
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
    trustTranscriptMetadata: config.trustTranscriptMetadata ?? true,
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
    readonly prompt_tokens_details?: {
      readonly cached_tokens?: number;
    };
    /** Anthropic via OpenRouter: tokens written to prompt cache this request. */
    readonly cache_creation_input_tokens?: number;
    /** Anthropic via OpenRouter: tokens read from prompt cache this request. */
    readonly cache_read_input_tokens?: number;
  };
}
