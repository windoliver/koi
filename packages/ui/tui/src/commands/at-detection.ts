/**
 * @-mention detection — pure functions for file path completion triggers.
 *
 * Detects "@" prefix in input text and extracts the partial file path
 * for the AtOverlay file completion overlay (#10).
 */

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect an @-mention prefix in input text. Returns the partial path or null.
 *
 * Rules:
 * - "@" must be at position 0 or preceded by whitespace (space or newline)
 * - The partial after "@" must not contain spaces or newlines (those terminate the mention)
 * - Returns the text after the last qualifying "@" through end of string
 *
 * Examples:
 *   "hello @src/m"  → "src/m"
 *   "@foo"           → "foo"
 *   "mid@word"       → null (no whitespace before @)
 *   "@has space"     → null (space in partial)
 */
export function detectAtPrefix(text: string): string | null {
  const lastAt = text.lastIndexOf("@");
  if (lastAt < 0) return null;

  // Only trigger if "@" is preceded by whitespace or is at start
  if (lastAt > 0 && text[lastAt - 1] !== " " && text[lastAt - 1] !== "\n") return null;

  const partial = text.slice(lastAt + 1);

  // Spaces or newlines in the partial terminate the mention
  if (partial.includes(" ") || partial.includes("\n")) return null;

  return partial;
}
