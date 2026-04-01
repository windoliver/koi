/**
 * Map accumulated stream state → Koi ModelResponse.
 */

import type { JsonObject, ModelContentBlock, ModelResponse, ModelStopReason } from "@koi/core";

/**
 * Accumulated state from streaming, used to build the final ModelResponse.
 */
export interface AccumulatedResponse {
  readonly responseId: string;
  readonly model: string;
  readonly textContent: string;
  readonly richContent: readonly ModelContentBlock[];
  readonly stopReason: ModelStopReason;
  /** Whether a finish_reason was received from the provider during streaming. */
  readonly receivedFinishReason: boolean;
  /** Whether any usage data was received from the provider during streaming. */
  readonly receivedUsage: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/**
 * Map an OpenAI finish_reason string to a Koi ModelStopReason.
 */
export function mapFinishReason(reason: string | null): ModelStopReason {
  if (reason === null) return "stop";
  switch (reason) {
    case "stop":
    case "end":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "error";
    default:
      return "error";
  }
}

/**
 * Build a Koi ModelResponse from accumulated stream state.
 */
export function buildModelResponse(acc: AccumulatedResponse): ModelResponse {
  const base: ModelResponse = {
    content: acc.textContent,
    model: acc.model,
    stopReason: acc.stopReason,
    responseId: acc.responseId,
  };

  const withRich: ModelResponse =
    acc.richContent.length > 0 ? { ...base, richContent: acc.richContent } : base;

  if (!acc.receivedUsage) return withRich;

  return {
    ...withRich,
    usage: {
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      ...(acc.cacheReadTokens > 0 ? { cacheReadTokens: acc.cacheReadTokens } : {}),
      ...(acc.cacheWriteTokens > 0 ? { cacheWriteTokens: acc.cacheWriteTokens } : {}),
    },
  };
}

/**
 * Create an empty AccumulatedResponse for progressive building.
 */
export function createEmptyAccumulator(model: string): AccumulatedResponse {
  return {
    responseId: "",
    model,
    textContent: "",
    richContent: [],
    stopReason: "stop",
    receivedFinishReason: false,
    receivedUsage: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

export type ToolArgsResult =
  | { readonly ok: true; readonly args: JsonObject }
  | { readonly ok: false; readonly raw: string };

/**
 * Parse accumulated tool call argument string as JSON.
 * Returns a discriminated result — callers must handle parse failures
 * explicitly instead of silently receiving `{}`.
 */
export function parseToolArguments(argsStr: string): ToolArgsResult {
  if (argsStr === "") return { ok: true, args: {} };
  try {
    const parsed: unknown = JSON.parse(argsStr);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, args: parsed as JsonObject };
    }
    return { ok: false, raw: argsStr };
  } catch {
    return { ok: false, raw: argsStr };
  }
}
