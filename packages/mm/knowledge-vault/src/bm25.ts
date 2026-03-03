/**
 * BM25 full-text search scoring.
 *
 * Hand-rolled implementation (~80 lines of logic). Zero external deps.
 * Supports weighted fields (title, tags get higher weight than body).
 */

/** Immutable search index built from a document corpus. */
export interface BM25Index {
  readonly search: (query: string, limit?: number) => readonly BM25Result[];
  readonly documentCount: number;
}

/** A single scored search result. */
export interface BM25Result {
  readonly id: string;
  readonly score: number;
}

/** Input document for indexing. */
export interface BM25Document {
  readonly id: string;
  readonly text: string;
  readonly titleText?: string | undefined;
  readonly tagText?: string | undefined;
}

/** Tuning parameters for BM25 scoring. */
export interface BM25Config {
  readonly k1?: number | undefined;
  readonly b?: number | undefined;
  readonly titleWeight?: number | undefined;
  readonly tagWeight?: number | undefined;
}

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;
const DEFAULT_TITLE_WEIGHT = 3.0;
const DEFAULT_TAG_WEIGHT = 2.0;

interface DocEntry {
  readonly id: string;
  readonly termFreqs: ReadonlyMap<string, number>;
  readonly length: number;
}

/**
 * Build an immutable BM25 index from a set of documents.
 *
 * Returns an index with a `search()` method that scores documents against
 * a query string using BM25 with field-weighted boosting.
 */
export function createBM25Index(
  documents: readonly BM25Document[],
  config?: BM25Config,
): BM25Index {
  const k1 = config?.k1 ?? DEFAULT_K1;
  const b = config?.b ?? DEFAULT_B;
  const titleWeight = config?.titleWeight ?? DEFAULT_TITLE_WEIGHT;
  const tagWeight = config?.tagWeight ?? DEFAULT_TAG_WEIGHT;

  const entries: readonly DocEntry[] = documents.map((doc) => {
    const weightedText = buildWeightedText(
      doc.text,
      doc.titleText,
      doc.tagText,
      titleWeight,
      tagWeight,
    );
    const terms = tokenize(weightedText);
    return {
      id: doc.id,
      termFreqs: computeTermFreqs(terms),
      length: terms.length,
    };
  });

  const n = entries.length;
  const avgDl = n === 0 ? 0 : entries.reduce((sum, e) => sum + e.length, 0) / n;

  // Pre-compute document frequency for each term
  const docFreqs = new Map<string, number>();
  for (const entry of entries) {
    for (const term of entry.termFreqs.keys()) {
      docFreqs.set(term, (docFreqs.get(term) ?? 0) + 1);
    }
  }

  function search(query: string, limit?: number): readonly BM25Result[] {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0 || n === 0) {
      return [];
    }

    const results: BM25Result[] = [];
    for (const entry of entries) {
      const score = computeScore(queryTerms, entry, n, avgDl, docFreqs, k1, b);
      if (score > 0) {
        results.push({ id: entry.id, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return limit !== undefined ? results.slice(0, limit) : results;
  }

  return { search, documentCount: n };
}

function computeScore(
  queryTerms: readonly string[],
  entry: DocEntry,
  n: number,
  avgDl: number,
  docFreqs: ReadonlyMap<string, number>,
  k1: number,
  b: number,
): number {
  // let is required — accumulating score across terms
  let score = 0;
  for (const term of queryTerms) {
    const tf = entry.termFreqs.get(term) ?? 0;
    if (tf === 0) continue;

    const df = docFreqs.get(term) ?? 0;
    // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1);
    // TF saturation with length normalization
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (entry.length / (avgDl || 1))));
    score += idf * tfNorm;
  }
  return score;
}

function buildWeightedText(
  body: string,
  title: string | undefined,
  tags: string | undefined,
  titleWeight: number,
  tagWeight: number,
): string {
  const parts: string[] = [body];
  if (title !== undefined && title !== "") {
    // Repeat title text to increase its weight
    const titleRepeat = Math.round(titleWeight);
    for (
      // let is required — loop counter
      let r = 0;
      r < titleRepeat;
      r++
    ) {
      parts.push(title);
    }
  }
  if (tags !== undefined && tags !== "") {
    const tagRepeat = Math.round(tagWeight);
    for (
      // let is required — loop counter
      let r = 0;
      r < tagRepeat;
      r++
    ) {
      parts.push(tags);
    }
  }
  return parts.join(" ");
}

function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_/.,;:!?()[\]{}<>"'`~@#$%^&*+=|\\]+/)
    .filter((t) => t.length > 0);
}

function computeTermFreqs(terms: readonly string[]): ReadonlyMap<string, number> {
  const freqs = new Map<string, number>();
  for (const term of terms) {
    freqs.set(term, (freqs.get(term) ?? 0) + 1);
  }
  return freqs;
}
