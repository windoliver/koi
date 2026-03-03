/**
 * Shared internal helpers used across adapter modes.
 *
 * Centralizes common functions to avoid duplication between
 * single-shot, long-lived, and PTY modes.
 */

import type { EngineCapabilities, EngineInput, EngineMetrics } from "@koi/core";
import { mapContentBlocksForEngine } from "@koi/core";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * External adapter capabilities — text only.
 * External processes receive stdin as plain text.
 */
export const EXTERNAL_CAPABILITIES: EngineCapabilities = {
  text: true,
  images: false,
  files: false,
  audio: false,
} as const;

// ---------------------------------------------------------------------------
// Input extraction
// ---------------------------------------------------------------------------

/**
 * Extract text input from EngineInput. Falls back to concatenating message
 * content blocks for the "messages" variant; returns empty string for "resume".
 * Non-text blocks are downgraded via mapContentBlocksForEngine before extraction.
 */
export function extractInputText(input: EngineInput): string {
  switch (input.kind) {
    case "text":
      return input.text;
    case "messages": {
      const parts: string[] = [];
      for (const msg of input.messages) {
        const mapped = mapContentBlocksForEngine(msg.content, EXTERNAL_CAPABILITIES);
        for (const block of mapped) {
          if (block.kind === "text") {
            parts.push(block.text);
          }
        }
      }
      return parts.join("\n");
    }
    case "resume":
      return "";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// History trimming (pure — returns new array)
// ---------------------------------------------------------------------------

/**
 * Trim output history to prevent unbounded growth.
 * Returns a new array with at most `maxEntries` elements (keeps the newest).
 */
export function trimHistory(history: readonly string[], maxEntries: number): readonly string[] {
  if (history.length > maxEntries) {
    return history.slice(history.length - maxEntries);
  }
  return history;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Create zeroed EngineMetrics (for non-model engines that don't track tokens). */
export function createZeroMetrics(durationMs: number): EngineMetrics {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    turns: 1,
    durationMs,
  };
}
