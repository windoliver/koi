/**
 * Shared helper to compute remaining text after removing matched regions.
 *
 * Uses match indices for a single O(n) pass instead of repeated `String.replace()`.
 * Patterns that want to skip some matches (e.g. JSON fences that aren't tool calls)
 * pass in a filtered subset of the original `matchAll()` results.
 */

export function computeRemainingText(text: string, matches: readonly RegExpExecArray[]): string {
  const segments: string[] = [];
  // let justified: cursor tracks position in the original text as we walk matches.
  let cursor = 0;

  for (const match of matches) {
    const start = match.index;
    if (start === undefined) continue;
    const end = start + match[0].length;
    if (cursor < start) {
      segments.push(text.slice(cursor, start));
    }
    cursor = end;
  }

  if (cursor < text.length) {
    segments.push(text.slice(cursor));
  }

  return segments.join("").trim();
}
