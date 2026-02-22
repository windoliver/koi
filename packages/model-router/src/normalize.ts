/**
 * Shared message normalization utilities for provider adapters.
 */

import type { ContentBlock, TextBlock } from "@koi/core";

/**
 * Extracts plain text from a content block array by filtering for text blocks
 * and joining their text. Used by all provider adapters that accept text-only input.
 */
export function normalizeToPlainText(content: readonly ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.kind === "text")
    .map((b) => b.text)
    .join("");
}
