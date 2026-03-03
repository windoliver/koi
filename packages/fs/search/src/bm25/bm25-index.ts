export interface BM25Config {
  readonly k1: number;
  readonly b: number;
}

export interface BM25Hit {
  readonly id: string;
  readonly score: number;
}

export interface BM25Index {
  readonly search: (terms: readonly string[], limit: number) => readonly BM25Hit[];
  readonly add: (id: string, tokens: readonly string[]) => BM25Index;
  readonly remove: (id: string) => BM25Index;
  readonly size: number;
}

const DEFAULT_CONFIG: BM25Config = { k1: 1.2, b: 0.75 } as const;

/** Default tokenizer: lowercase + split on whitespace */
export function defaultTokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

interface DocEntry {
  readonly tokens: readonly string[];
  readonly length: number;
}

interface InvertedEntry {
  readonly docId: string;
  readonly tf: number;
}

/**
 * Creates an immutable BM25 index.
 * `add()` and `remove()` return new index instances.
 */
export function createBm25Index(config?: Partial<BM25Config>): BM25Index {
  return buildIndex(new Map(), { ...DEFAULT_CONFIG, ...config });
}

function buildIndex(docs: ReadonlyMap<string, DocEntry>, config: BM25Config): BM25Index {
  // Lazy-computed inverted index + stats
  let invertedIndex: Map<string, readonly InvertedEntry[]> | undefined;
  let avgDl = 0;

  function ensureIndex(): Map<string, readonly InvertedEntry[]> {
    if (invertedIndex !== undefined) return invertedIndex;

    invertedIndex = new Map();
    let totalLength = 0;

    for (const [docId, doc] of docs) {
      totalLength += doc.length;

      // Count term frequencies
      const tfMap = new Map<string, number>();
      for (const token of doc.tokens) {
        tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
      }

      for (const [term, tf] of tfMap) {
        const existing = invertedIndex.get(term) ?? [];
        invertedIndex.set(term, [...existing, { docId, tf }]);
      }
    }

    avgDl = docs.size > 0 ? totalLength / docs.size : 0;
    return invertedIndex;
  }

  function search(terms: readonly string[], limit: number): readonly BM25Hit[] {
    if (terms.length === 0 || docs.size === 0) return [];

    const index = ensureIndex();
    const n = docs.size;
    const scores = new Map<string, number>();

    for (const term of terms) {
      const postings = index.get(term);
      if (postings === undefined) continue;

      const df = postings.length;
      // BM25 IDF: log((N - df + 0.5) / (df + 0.5) + 1)
      const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1);

      for (const posting of postings) {
        const doc = docs.get(posting.docId);
        if (doc === undefined) continue;

        const dl = doc.length;
        // BM25 TF component: (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgDl))
        const tfNorm =
          (posting.tf * (config.k1 + 1)) /
          (posting.tf + config.k1 * (1 - config.b + config.b * (dl / avgDl)));
        const score = idf * tfNorm;

        scores.set(posting.docId, (scores.get(posting.docId) ?? 0) + score);
      }
    }

    const hits: BM25Hit[] = [];
    for (const [id, score] of scores) {
      if (score > 0) hits.push({ id, score });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  function add(id: string, tokens: readonly string[]): BM25Index {
    const newDocs = new Map(docs);
    newDocs.set(id, { tokens, length: tokens.length });
    return buildIndex(newDocs, config);
  }

  function remove(id: string): BM25Index {
    const newDocs = new Map(docs);
    newDocs.delete(id);
    return buildIndex(newDocs, config);
  }

  return {
    search,
    add,
    remove,
    size: docs.size,
  };
}
