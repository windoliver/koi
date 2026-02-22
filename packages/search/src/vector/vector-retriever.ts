import type {
  Embedder,
  KoiError,
  Result,
  Retriever,
  SearchFilter,
  SearchPage,
  SearchQuery,
  SearchResult,
} from "@koi/core";
import type { VectorStore } from "./sqlite-vec.js";

export interface VectorRetrieverConfig {
  readonly embedder: Embedder;
  readonly store: VectorStore;
  readonly contentStore: ReadonlyMap<string, string>;
}

export function createVectorRetriever(config: VectorRetrieverConfig): Retriever {
  return {
    retrieve: async (query: SearchQuery): Promise<Result<SearchPage, KoiError>> => {
      const embedding = await config.embedder.embed(query.text);

      // Over-fetch to allow for post-filtering and hasMore detection
      const offset = query.offset ?? 0;
      const fetchLimit = query.filter ? (offset + query.limit) * 3 : offset + query.limit + 1;
      const hits = config.store.search(embedding, fetchLimit);

      let results: SearchResult[] = hits.map((hit) => ({
        id: hit.id,
        score: hit.score,
        content: config.contentStore.get(hit.id) ?? "",
        metadata: hit.metadata,
        source: "vector",
      }));

      // Apply filter
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
