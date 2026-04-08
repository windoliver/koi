import type { JsonObject, ToolCallId } from "@koi/core";

/** A completed tool call with accumulated and parsed arguments. */
export interface AccumulatedToolCall {
  /** Discriminator tag — allows downstream consumers to distinguish this
   *  metadata object from real tool execution output on tool_call_end.result. */
  readonly __kind: "AccumulatedToolCall";
  readonly toolName: string;
  readonly callId: ToolCallId;
  /** The raw JSON string assembled from deltas. */
  readonly rawArgs: string;
  /** Parsed arguments. `undefined` when JSON parsing failed. */
  readonly parsedArgs: JsonObject | undefined;
  /** Set when JSON parsing failed — describes the parse error. Callers should
   *  check this field to distinguish parse failures from valid empty args. */
  readonly parseError?: string | undefined;
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
