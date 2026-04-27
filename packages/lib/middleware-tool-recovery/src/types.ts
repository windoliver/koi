/**
 * Types for text-based tool call recovery middleware.
 */

import type { JsonObject } from "@koi/core/common";

/** A tool call parsed from model text output. */
export interface ParsedToolCall {
  readonly toolName: string;
  readonly arguments: JsonObject;
}

/** Result of applying a pattern to text. */
export interface RecoveryResult {
  readonly toolCalls: readonly ParsedToolCall[];
  readonly remainingText: string;
}

/**
 * A named pattern that detects tool calls embedded in text.
 *
 * `detect` is synchronous and pure: given text, return either undefined
 * (no match for this pattern) or a `RecoveryResult` with extracted calls
 * and the original text minus the matched regions.
 *
 * `marker`, when present, is a fixed substring that always appears at the
 * start of any tool call this pattern can match (e.g. `"<tool_call>"` for
 * Hermes). The streaming wrapper uses markers to preserve incremental
 * output: while no marker substring has been seen in the assistant text
 * stream, text/thinking/usage chunks are forwarded immediately. Once a
 * marker is detected the wrapper switches to buffering until `done` so
 * structured tool-call chunks can be synthesized. Patterns without a
 * marker force full buffering for the entire stream.
 */
export interface ToolCallPattern {
  readonly name: string;
  readonly detect: (text: string) => RecoveryResult | undefined;
  readonly marker?: string;
}

/** Events emitted during tool call recovery for observability. */
export type RecoveryEvent =
  | {
      readonly kind: "recovered";
      readonly pattern: string;
      readonly toolCalls: readonly ParsedToolCall[];
    }
  | { readonly kind: "rejected"; readonly toolName: string; readonly reason: string }
  | {
      readonly kind: "parse_error";
      readonly pattern: string;
      readonly raw: string;
      readonly error: string;
    };
