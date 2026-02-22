/**
 * Text source resolver — returns inline text directly.
 */

import type { SourceResult, TextSource } from "../types.js";

/** Resolves a text source. Never fails — content is inline. */
export function resolveTextSource(source: TextSource): Promise<SourceResult> {
  return Promise.resolve({
    label: source.label ?? "Text",
    content: source.text,
    tokens: 0, // Caller estimates after resolution
    source,
  });
}
