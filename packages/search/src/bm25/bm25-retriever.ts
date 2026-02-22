import type { KoiError, Result } from "@koi/core";
import type { Retriever } from "../contracts.js";
import type { QueryExpansionConfig } from "../query/expand.js";
import { expandQuery } from "../query/expand.js";
import type { SearchFilter, SearchPage, SearchQuery, SearchResult } from "../types.js";
import type { BM25Index } from "./bm25-index.js";
import { defaultTokenize } from "./bm25-index.js";

interface BM25Doc {
  readonly id: string;
  readonly content: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface BM25RetrieverConfig {
  readonly index: BM25Index;
  readonly documents: ReadonlyMap<string, BM25Doc>;
  readonly tokenize?: (text: string) => readonly string[];
  /** Optional query expansion to filter stop words and short tokens before search */
  readonly queryExpansion?: QueryExpansionConfig;
}

export function createBm25Retriever(config: BM25RetrieverConfig): Retriever {
  const tokenize = config.tokenize ?? defaultTokenize;

  return {
    retrieve: async (query: SearchQuery): Promise<Result<SearchPage, KoiError>> => {
      const terms = config.queryExpansion
        ? expandQuery(query.text, config.queryExpansion)
        : tokenize(query.text);
      if (terms.length === 0) {
        return { ok: true, value: { results: [], hasMore: false } };
      }

      // Over-fetch to allow for post-filtering and hasMore detection
      const offset = query.offset ?? 0;
      const fetchLimit = query.filter ? (offset + query.limit) * 3 : offset + query.limit + 1;
      const hits = config.index.search(terms, fetchLimit);

      let results: SearchResult[] = hits
        .map((hit) => {
          const doc = config.documents.get(hit.id);
          if (doc === undefined) return undefined;
          return {
            id: hit.id,
            score: hit.score,
            content: doc.content,
            metadata: doc.metadata,
            source: "bm25",
          };
        })
        .filter((r): r is SearchResult => r !== undefined);

      // Apply post-filter on metadata
      if (query.filter !== undefined) {
        const filter = query.filter;
        results = results.filter((r) => matchesFilter(r.metadata, filter));
      }

      // Apply minScore
      if (query.minScore !== undefined) {
        const min = query.minScore;
        results = results.filter((r) => r.score >= min);
      }

      // Apply offset and limit
      const paged = results.slice(offset, offset + query.limit);

      return {
        ok: true,
        value: {
          results: paged,
          total: results.length,
          hasMore: offset + query.limit < results.length,
        },
      };
    },
  };
}

function matchesFilter(metadata: Readonly<Record<string, unknown>>, filter: SearchFilter): boolean {
  switch (filter.kind) {
    case "eq":
      return metadata[filter.field] === filter.value;
    case "ne":
      return metadata[filter.field] !== filter.value;
    case "gt": {
      const gtVal = metadata[filter.field];
      return typeof gtVal === "number" && gtVal > filter.value;
    }
    case "lt": {
      const ltVal = metadata[filter.field];
      return typeof ltVal === "number" && ltVal < filter.value;
    }
    case "in":
      return filter.values.includes(metadata[filter.field]);
    case "and":
      return filter.filters.every((f) => matchesFilter(metadata, f));
    case "or":
      return filter.filters.some((f) => matchesFilter(metadata, f));
    case "not":
      return !matchesFilter(metadata, filter.filter);
  }
}
