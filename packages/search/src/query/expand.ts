/**
 * Query expansion: tokenize, filter stop words, deduplicate.
 * Returns expanded query terms suitable for BM25 or hybrid search.
 */

export interface QueryExpansionConfig {
  readonly stopWords?: ReadonlySet<string>;
  /** Minimum token length to keep. Default 2 */
  readonly minTokenLength?: number;
}

// Built-in English stop words (deterministic, no external deps)
const DEFAULT_STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "am",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "do",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "she",
  "so",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "up",
  "us",
  "was",
  "we",
  "what",
  "when",
  "which",
  "who",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

const DEFAULT_MIN_TOKEN_LENGTH = 2;

/**
 * Expand a query string into filtered, deduplicated terms.
 *
 * Pipeline: lowercase → tokenize on non-alphanumeric → filter stop words →
 *           filter short tokens → deduplicate (preserving first occurrence order).
 */
export function expandQuery(text: string, config?: QueryExpansionConfig): readonly string[] {
  const stopWords = config?.stopWords ?? DEFAULT_STOP_WORDS;
  const minLength = config?.minTokenLength ?? DEFAULT_MIN_TOKEN_LENGTH;

  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= minLength && !stopWords.has(t));

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      unique.push(token);
    }
  }

  return unique;
}
