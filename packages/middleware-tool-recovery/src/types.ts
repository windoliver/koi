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

/** A named pattern that detects tool calls embedded in text. */
export interface ToolCallPattern {
  readonly name: string;
  readonly detect: (text: string) => RecoveryResult | undefined;
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
