/**
 * Configuration types and defaults for @koi/api-client.
 */

import type { RetryConfig } from "@koi/errors";

/** Supported Anthropic SDK transport backends. */
export type AnthropicProvider = "direct" | "bedrock" | "vertex";

export interface AnthropicClientConfig {
  /** Transport backend. Default: "direct". */
  readonly provider?: AnthropicProvider | undefined;
  /** API key for direct provider. Falls back to ANTHROPIC_API_KEY env. */
  readonly apiKey?: string | undefined;
  /** Default model ID. Default: "claude-sonnet-4-5-20250929". */
  readonly model?: string | undefined;
  /** Fallback model for retry after primary exhausts retries. */
  readonly fallbackModel?: string | undefined;
  /** Default max tokens. Default: 4096. */
  readonly maxTokens?: number | undefined;
  /** Request timeout in ms. Default: 120_000. */
  readonly timeoutMs?: number | undefined;
  /** Override base URL for direct provider. */
  readonly baseUrl?: string | undefined;
  /** AWS region for Bedrock provider. */
  readonly awsRegion?: string | undefined;
  /** AWS access key for Bedrock provider. */
  readonly awsAccessKey?: string | undefined;
  /** AWS secret key for Bedrock provider. */
  readonly awsSecretKey?: string | undefined;
  /** AWS session token for Bedrock provider. */
  readonly awsSessionToken?: string | undefined;
  /** Google Cloud project ID for Vertex provider. */
  readonly googleProjectId?: string | undefined;
  /** Google Cloud region for Vertex provider. */
  readonly googleRegion?: string | undefined;
  /** Retry configuration for non-streaming calls. Uses @koi/errors defaults when omitted. */
  readonly retryConfig?: RetryConfig | undefined;
}

export const DEFAULT_MODEL = "claude-sonnet-4-5-20250929" as const;
export const DEFAULT_MAX_TOKENS = 4096 as const;
export const DEFAULT_TIMEOUT_MS = 120_000 as const;
