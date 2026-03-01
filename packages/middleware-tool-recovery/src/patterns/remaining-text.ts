/**
 * Shared helper to compute remaining text after removing matched regions.
 *
 * Uses match indices for O(n) single-pass instead of repeated String.replace().
 */

/**
 * Build remaining text from the gaps between matched regions.
 * Handles overlapping or adjacent matches correctly.
 */
export function computeRemainingText(text: string, matches: readonly RegExpExecArray[]): string {
  const segments: string[] = [];
  // let justified: cursor tracks position in the original text
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
