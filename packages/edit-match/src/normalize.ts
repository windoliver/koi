/**
 * Normalization utilities for whitespace and indentation.
 */

/** Collapse all whitespace runs to a single space and trim. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Normalize indentation by stripping the minimum common leading whitespace
 * from all non-empty lines. Preserves relative indentation.
 */
export function normalizeIndentation(text: string): string {
  const lines = text.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);

  if (nonEmptyLines.length === 0) {
    return text;
  }

  const minIndent = Math.min(
    ...nonEmptyLines.map((line) => {
      const match = /^(\s*)/.exec(line);
      return match !== null ? (match[1]?.length ?? 0) : 0;
    }),
  );

  if (minIndent === 0) {
    return text;
  }

  return lines.map((line) => (line.trim().length > 0 ? line.slice(minIndent) : line)).join("\n");
}
