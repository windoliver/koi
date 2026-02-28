/**
 * Token-budget enforcement for content resolution.
 *
 * Token estimation delegated to @koi/token-estimator; this module
 * owns truncation logic only.
 */

import { CHARS_PER_TOKEN, estimateTokens } from "@koi/token-estimator";
import { truncateSafe } from "./truncate.js";

// Re-export for backward compatibility with existing consumers.
export { CHARS_PER_TOKEN, estimateTokens } from "@koi/token-estimator";

/** Result of truncating text to a token budget. */
export interface TruncateResult {
  readonly text: string;
  readonly warning: string | undefined;
}

/**
 * Truncates text to fit within a token budget.
 * Returns the (possibly truncated) text and an optional warning.
 */
export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
  label: string,
): TruncateResult {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return { text, warning: undefined };
  return {
    text: truncateSafe(text, maxChars),
    warning: `${label} content truncated from ~${estimateTokens(text)} to ${maxTokens} tokens`,
  };
}
