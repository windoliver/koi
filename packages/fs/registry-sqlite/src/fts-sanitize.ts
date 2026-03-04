/**
 * FTS5 query sanitization.
 *
 * Strips FTS5 operators and special characters from user input
 * to prevent query syntax errors. Produces a safe plain-text query.
 */

/**
 * Sanitize user input for use in FTS5 queries.
 *
 * Removes FTS5 operators (AND, OR, NOT, NEAR), column filters,
 * quotes, parentheses, asterisks, and carets. Collapses whitespace.
 * Returns empty string for blank/whitespace-only input.
 */
export function sanitizeFtsQuery(raw: string): string {
  // Strip special FTS5 characters: " * ^ ( ) { } :
  const stripped = raw.replace(/["*^(){}:]/g, " ");

  // Remove FTS5 boolean operators (whole words only, case-insensitive)
  const withoutOps = stripped.replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ");

  // Collapse whitespace and trim
  return withoutOps.replace(/\s+/g, " ").trim();
}
