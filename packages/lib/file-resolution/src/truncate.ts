/**
 * Surrogate-pair-safe string truncation.
 *
 * JavaScript strings are UTF-16. Characters outside the BMP (emoji, CJK extensions)
 * are encoded as surrogate pairs (2 code units). A naive `text.slice(0, n)` can split
 * a pair, producing a malformed string with a dangling high surrogate.
 *
 * This function backs off by one character when the slice boundary lands on a high surrogate.
 */

/**
 * Returns true if the character at `index` is a UTF-16 high surrogate (0xD800–0xDBFF).
 */
function isHighSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Truncates `text` to at most `maxChars` code units without splitting a surrogate pair.
 * If the boundary lands on a high surrogate, backs off by one to keep the string valid.
 */
export function truncateSafe(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // If the last included char is a high surrogate, it would be orphaned — back off
  const end = isHighSurrogate(text, maxChars - 1) ? maxChars - 1 : maxChars;
  return text.slice(0, end);
}
