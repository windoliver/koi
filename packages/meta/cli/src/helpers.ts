/**
 * Shared utilities for CLI commands (start, serve).
 */

import type { ContentBlock } from "@koi/core";

/**
 * Extracts text from an array of content blocks, joining with newlines.
 */
export function extractTextFromBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
}
