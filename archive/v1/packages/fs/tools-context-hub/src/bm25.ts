/**
 * BM25 search scorer for Context Hub registry entries.
 *
 * Pure functions — no side effects, no dependencies.
 * Matches Context Hub's own BM25 parameters: k1=1.5, b=0.75.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const K1 = 1.5;
const B = 0.75;

/** Field weights: name matters most, then tags, then description. */
const FIELD_WEIGHTS: Readonly<Record<string, number>> = {
  name: 3.0,
  tags: 2.0,
  description: 1.0,
} as const;

/** Common English stop words filtered during tokenization. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "his",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "out",
  "so",
  "than",
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
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "will",
  "with",
  "you",
  "your",
]);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenize a string: lowercase, strip punctuation (keep hyphens),
 * split on whitespace/hyphens, filter stop words, drop tokens < 2 chars.
 */
export function tokenize(text: string): readonly string[] {
  if (text.trim() === "") return [];

  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .split(/[\s-]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface SearchIndexEntry {
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface SearchIndex {
  readonly entries: readonly IndexedEntry[];
  readonly idf: ReadonlyMap<string, number>;
  readonly avgFieldLengths: Readonly<Record<string, number>>;
}

interface IndexedEntry {
  readonly id: string;
  readonly fieldTokens: Readonly<Record<string, readonly string[]>>;
}

/**
 * Build a search index from registry entries.
 *
 * Each entry provides `fields` keyed by field name (e.g., "name", "tags", "description").
 * Returns an index with pre-computed IDF scores and average field lengths.
 */
export function buildSearchIndex(entries: readonly SearchIndexEntry[]): SearchIndex {
  const fieldNames = Object.keys(FIELD_WEIGHTS);
  const docCount = entries.length;

  // Tokenize all entries
  const indexed: readonly IndexedEntry[] = entries.map((entry) => ({
    id: entry.id,
    fieldTokens: Object.fromEntries(fieldNames.map((f) => [f, tokenize(entry.fields[f] ?? "")])),
  }));

  // Compute document frequency for each term (across all fields)
  const df = new Map<string, number>();
  for (const entry of indexed) {
    const seenTerms = new Set<string>();
    for (const field of fieldNames) {
      const tokens = entry.fieldTokens[field];
      if (tokens !== undefined) {
        for (const token of tokens) {
          seenTerms.add(token);
        }
      }
    }
    for (const term of seenTerms) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  // Compute IDF: log((N - df + 0.5) / (df + 0.5) + 1)
  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    idf.set(term, Math.log((docCount - freq + 0.5) / (freq + 0.5) + 1));
  }

  // Compute average field lengths
  const avgFieldLengths: Record<string, number> = {};
  for (const field of fieldNames) {
    const totalLength = indexed.reduce(
      (sum, entry) => sum + (entry.fieldTokens[field]?.length ?? 0),
      0,
    );
    avgFieldLengths[field] = docCount > 0 ? totalLength / docCount : 0;
  }

  return { entries: indexed, idf, avgFieldLengths };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score a single field's tokens against a set of query terms using BM25.
 */
function scoreField(
  fieldTokens: readonly string[],
  queryTerms: readonly string[],
  idf: ReadonlyMap<string, number>,
  avgFieldLength: number,
): number {
  const fieldLength = fieldTokens.length;
  if (fieldLength === 0) return 0;

  // Count term frequencies in this field
  const tf = new Map<string, number>();
  for (const token of fieldTokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }

  let score = 0;
  for (const term of queryTerms) {
    const termFreq = tf.get(term) ?? 0;
    if (termFreq === 0) continue;

    const termIdf = idf.get(term) ?? 0;
    const denominator = termFreq + K1 * (1 - B + B * (fieldLength / (avgFieldLength || 1)));
    score += termIdf * ((termFreq * (K1 + 1)) / denominator);
  }

  return score;
}

export interface SearchResult {
  readonly id: string;
  readonly score: number;
}

/**
 * Search the index for entries matching a query string.
 *
 * Returns results sorted by descending BM25 score.
 * Entries with score 0 are excluded.
 */
export function searchIndex(
  index: SearchIndex,
  query: string,
  maxResults: number,
): readonly SearchResult[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const results: SearchResult[] = [];

  for (const entry of index.entries) {
    let totalScore = 0;
    for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
      const tokens = entry.fieldTokens[field];
      if (tokens === undefined || tokens.length === 0) continue;
      totalScore +=
        weight * scoreField(tokens, queryTerms, index.idf, index.avgFieldLengths[field] ?? 0);
    }
    if (totalScore > 0) {
      results.push({ id: entry.id, score: totalScore });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}
