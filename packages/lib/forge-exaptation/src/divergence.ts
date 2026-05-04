/**
 * Pure tokenization + Jaccard distance for purpose-drift detection.
 * Zero side effects, no state.
 */

const STOPWORDS: ReadonlySet<string> = new Set([
  "and",
  "are",
  "but",
  "for",
  "from",
  "has",
  "have",
  "into",
  "not",
  "the",
  "this",
  "that",
  "those",
  "these",
  "with",
  "was",
  "were",
  "will",
  "would",
  "could",
  "should",
]);

/** Lowercase, split on non-word, drop stopwords and tokens shorter than 3 chars. */
export function tokenize(text: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const word of text.toLowerCase().split(/\W+/)) {
    if (word.length >= 3 && !STOPWORDS.has(word)) {
      tokens.add(word);
    }
  }
  return tokens;
}

/**
 * Jaccard distance between two token sets.
 * 0 = identical, 1 = disjoint. Two empty sets return 0 (no signal when no data).
 */
export function computeJaccardDistance(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  // let: intersection accumulator
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of smaller) {
    if (larger.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return 1 - intersection / union;
}
