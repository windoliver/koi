/**
 * SDKResultMessage → EngineMetrics mapping.
 *
 * Maps the Claude Agent SDK's result format to Koi's EngineMetrics + rich metadata.
 */

import type { EngineMetrics, JsonObject } from "@koi/core";

/**
 * SDK result shape — only the fields we consume.
 * Avoids importing SDK types directly into our public surface.
 */
export interface SdkResultFields {
  readonly num_turns?: number;
  readonly duration_ms?: number;
  readonly duration_api_ms?: number;
  readonly total_cost_usd?: number;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
  };
  readonly modelUsage?: Readonly<Record<string, unknown>>;
  readonly errors?: readonly string[];
  readonly permission_denials?: readonly {
    readonly tool_name: string;
    readonly tool_use_id: string;
  }[];
}

/**
 * Map SDK result fields to Koi EngineMetrics.
 *
 * `inputTokens` is the total tokens processed (cached + uncached), matching
 * the OpenAI / LangChain / LiteLLM convention. Anthropic's `input_tokens`
 * field only counts uncached tokens — we add cache_read and cache_creation
 * to get the true total. Cache breakdowns remain in `mapRichMetadata`.
 */
export function mapMetrics(result: SdkResultFields): EngineMetrics {
  const uncached = result.usage?.input_tokens ?? 0;
  const cacheRead = result.usage?.cache_read_input_tokens ?? 0;
  const cacheCreate = result.usage?.cache_creation_input_tokens ?? 0;
  const inputTokens = uncached + cacheRead + cacheCreate;
  const outputTokens = result.usage?.output_tokens ?? 0;

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    turns: result.num_turns ?? 0,
    durationMs: result.duration_ms ?? 0,
  };
}

/**
 * Map SDK result fields to rich metadata for EngineOutput.metadata.
 */
export function mapRichMetadata(result: SdkResultFields): JsonObject {
  const metadata: Record<string, unknown> = {};

  if (result.total_cost_usd !== undefined) {
    metadata.totalCostUsd = result.total_cost_usd;
  }
  if (result.duration_api_ms !== undefined) {
    metadata.apiDurationMs = result.duration_api_ms;
  }
  if (result.modelUsage !== undefined) {
    metadata.modelUsage = result.modelUsage;
  }
  if (result.usage?.cache_read_input_tokens !== undefined) {
    metadata.cacheReadTokens = result.usage.cache_read_input_tokens;
  }
  if (result.usage?.cache_creation_input_tokens !== undefined) {
    metadata.cacheCreationTokens = result.usage.cache_creation_input_tokens;
  }
  if (result.errors !== undefined && result.errors.length > 0) {
    metadata.errors = result.errors;
  }
  if (result.permission_denials !== undefined && result.permission_denials.length > 0) {
    metadata.permissionDenials = result.permission_denials;
  }

  return metadata as JsonObject;
}
