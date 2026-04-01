import type { JsonObject, ToolCallId } from "@koi/core";

/** A completed tool call with accumulated and parsed arguments. */
export interface AccumulatedToolCall {
  readonly toolName: string;
  readonly callId: ToolCallId;
  /** The raw JSON string assembled from deltas. */
  readonly rawArgs: string;
  /** Parsed arguments. `undefined` when JSON parsing failed. */
  readonly parsedArgs: JsonObject | undefined;
}

/** In-flight tool call being accumulated. */
export interface ToolCallAccumulator {
  readonly toolName: string;
  readonly callId: ToolCallId;
  readonly fragments: readonly string[];
}

/** Summary produced alongside the final `done` event. */
export interface StreamConsumerResult {
  readonly toolCalls: readonly AccumulatedToolCall[];
  readonly inputTokens: number;
  readonly outputTokens: number;
}
