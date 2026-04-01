/**
 * Jaccard distance scoring for exaptation detection.
 *
 * Pure functions — no side effects, no state. Computes divergence
 * between a brick's stated purpose and observed usage context.
 */

// ---------------------------------------------------------------------------
// Stopwords — filtered from tokenization
// ---------------------------------------------------------------------------

const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "about",
  "and",
  "but",
  "or",
  "not",
  "no",
  "if",
  "then",
  "than",
  "so",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
]);

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Tokenize text into a set of keywords.
 *
 * Lowercases, splits on non-word characters, filters stopwords
 * and tokens shorter than 3 characters.
 */
export function tokenize(text: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  const words = text.toLowerCase().split(/\W+/);
  for (const word of words) {
    if (word.length >= 3 && !STOPWORDS.has(word)) {
      tokens.add(word);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Jaccard distance
// ---------------------------------------------------------------------------

/**
 * Compute Jaccard distance between two token sets.
 *
 * Returns 0 when identical, 1 when completely disjoint.
 * Returns 0 for empty sets (no drift signal when no data).
 */
export function computeJaccardDistance(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  // let: accumulator for intersection count
  let intersectionSize = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;

  for (const token of smaller) {
    if (larger.has(token)) {
      intersectionSize++;
    }
  }

  const unionSize = a.size + b.size - intersectionSize;
  if (unionSize === 0) return 0;

  return 1 - intersectionSize / unionSize;
}

// ---------------------------------------------------------------------------
// Text truncation
// ---------------------------------------------------------------------------

/**
 * Truncate text to the first N words.
 */
export function truncateToWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ");
}
