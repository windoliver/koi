/**
 * Token estimation and budget enforcement for content resolution.
 */

/** Approximate chars per token — same heuristic as @koi/context. */
export const CHARS_PER_TOKEN = 4;

/** Estimates token count from text length. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

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
    text: text.slice(0, maxChars),
    warning: `${label} content truncated from ~${estimateTokens(text)} to ${maxTokens} tokens`,
  };
}
