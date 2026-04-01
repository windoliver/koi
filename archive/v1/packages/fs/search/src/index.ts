/**
 * @koi/search — Pluggable search backend (Layer 2)
 *
 * Supports BM25 (keyword), vector (semantic), and hybrid (fusion) search.
 * Wraps local SQLite by default; swap to Nexus via manifest config.
 */

import type { BM25Config } from "./bm25/bm25-index.js";
import { createBm25Index, defaultTokenize } from "./bm25/bm25-index.js";
import { createBm25Retriever } from "./bm25/bm25-retriever.js";
import type { Embedder, Indexer, Retriever } from "./contracts.js";
import type { EmbedderCacheConfig } from "./embedder-cache.js";
import { createCachedEmbedder } from "./embedder-cache.js";
import type { FusionStrategy } from "./fusion-types.js";
import { createHybridRetriever } from "./hybrid/hybrid-retriever.js";
import type { MmrConfig } from "./hybrid/mmr.js";
import type { TemporalDecayConfig } from "./hybrid/temporal-decay.js";
import type { ChunkerConfig } from "./indexer/chunker.js";
import { createSqliteIndexer } from "./indexer/sqlite-indexer.js";
import type { QueryExpansionConfig } from "./query/expand.js";
import type { IndexDocument } from "./types.js";
import { createVectorStore } from "./vector/sqlite-vec.js";
import { createVectorRetriever } from "./vector/vector-retriever.js";

export interface KoiSearchConfig {
  readonly dbPath?: string;
  readonly embedder: Embedder;
  readonly fusion?: FusionStrategy;
  readonly bm25?: Partial<BM25Config>;
  readonly chunker?: Partial<ChunkerConfig>;
  readonly embeddingBatchSize?: number;
  readonly mmr?: Partial<MmrConfig>;
  readonly temporalDecay?: Partial<TemporalDecayConfig>;
  /** Enable embedding cache. Pass `{}` for defaults or `{ maxSize: N }` to configure. */
  readonly cache?: Pick<EmbedderCacheConfig, "maxSize">;
  /** Query expansion config for BM25 stop-word filtering */
  readonly queryExpansion?: QueryExpansionConfig;
  /** Plug in a remote backend (e.g. Nexus). Skips all local SQLite/BM25/vector setup. */
  readonly backend?: {
    readonly indexer: Indexer;
    readonly retriever: Retriever;
  };
}

export interface KoiSearch {
  readonly retriever: Retriever;
  readonly bm25: Retriever | undefined;
  readonly vector: Retriever | undefined;
  readonly indexer: Indexer;
  readonly close: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-empty-function -- noop for remote backends
const noop = (): void => {};

export function createSearch(config: KoiSearchConfig): KoiSearch {
  // Remote backend — skip all local setup
  if (config.backend) {
    return {
      retriever: config.backend.retriever,
      bm25: undefined,
      vector: undefined,
      indexer: config.backend.indexer,
      close: noop,
    };
  }

  const dbPath = config.dbPath ?? ":memory:";
  const fusionStrategy: FusionStrategy = config.fusion ?? { kind: "rrf", k: 60 };

  // Wrap embedder with cache if configured
  const embedder = config.cache
    ? createCachedEmbedder({
        embedder: config.embedder,
        ...(config.cache.maxSize !== undefined ? { maxSize: config.cache.maxSize } : {}),
      })
    : config.embedder;

  // BM25 state (mutable internal state, immutable interface)
  let bm25Index = createBm25Index(config.bm25);
  const bm25Documents = new Map<
    string,
    { id: string; content: string; metadata: Readonly<Record<string, unknown>> }
  >();

  const bm25Retriever = createBm25Retriever({
    get index() {
      return bm25Index;
    },
    get documents() {
      return bm25Documents;
    },
    ...(config.queryExpansion !== undefined ? { queryExpansion: config.queryExpansion } : {}),
  });

  // Vector store
  const vectorStore = createVectorStore({ dbPath, dimensions: embedder.dimensions });

  // Content store for vector retriever
  const contentStore = new Map<string, string>();

  const vectorRetriever = createVectorRetriever({
    embedder,
    store: vectorStore,
    get contentStore() {
      return contentStore;
    },
  });

  // Hybrid retriever
  const hybridRetriever = createHybridRetriever({
    retrievers: [bm25Retriever, vectorRetriever],
    fusion: fusionStrategy,
    ...(config.mmr !== undefined ? { mmr: config.mmr } : {}),
    ...(config.temporalDecay !== undefined ? { temporalDecay: config.temporalDecay } : {}),
  });

  // SQLite indexer
  const sqliteIndexerConfig: Parameters<typeof createSqliteIndexer>[0] = {
    dbPath,
    embedder,
    ...(config.chunker !== undefined ? { chunkerConfig: config.chunker } : {}),
    ...(config.embeddingBatchSize !== undefined
      ? { embeddingBatchSize: config.embeddingBatchSize }
      : {}),
  };
  const sqliteIndexer = createSqliteIndexer(sqliteIndexerConfig);

  // Wrap the indexer to also update BM25 + content stores
  const indexer: Indexer = {
    index: async (documents) => {
      // Compute embeddings once and enrich documents for downstream consumers
      const enriched: IndexDocument[] = [];
      for (const doc of documents) {
        const tokens = defaultTokenize(doc.content);
        bm25Index = bm25Index.add(doc.id, tokens);
        bm25Documents.set(doc.id, {
          id: doc.id,
          content: doc.content,
          metadata: doc.metadata ?? {},
        });
        contentStore.set(doc.id, doc.content);

        // Compute embedding once — reuse pre-computed if available
        const emb = doc.embedding ?? (await embedder.embed(doc.content));
        vectorStore.insert(doc.id, emb, doc.metadata ?? {});
        enriched.push({ ...doc, embedding: emb });
      }

      // Pass enriched docs so sqliteIndexer skips re-embedding single-chunk docs
      return sqliteIndexer.index(enriched);
    },
    remove: async (ids) => {
      for (const id of ids) {
        bm25Index = bm25Index.remove(id);
        bm25Documents.delete(id);
        contentStore.delete(id);
        vectorStore.remove(id);
      }
      return sqliteIndexer.remove(ids);
    },
  };

  function close(): void {
    vectorStore.close();
    sqliteIndexer.close();
  }

  return {
    retriever: hybridRetriever,
    bm25: bm25Retriever,
    vector: vectorRetriever,
    indexer,
    close,
  };
}

export type { BM25Config, BM25Hit, BM25Index } from "./bm25/bm25-index.js";
export { createBm25Index, defaultTokenize } from "./bm25/bm25-index.js";
export type { BM25RetrieverConfig } from "./bm25/bm25-retriever.js";
export { createBm25Retriever } from "./bm25/bm25-retriever.js";
export type { CachedEmbedder, CacheStats, EmbedderCacheConfig } from "./embedder-cache.js";
export { createCachedEmbedder } from "./embedder-cache.js";
// Re-export individual pieces for advanced usage
export type { FusionFunction, FusionStrategy, ScoreNormalizer } from "./fusion-types.js";
export { applyFusion, applyLinear, applyRrf, applyWeightedRrf } from "./hybrid/fusion.js";
export type { HybridRetrieverConfig } from "./hybrid/hybrid-retriever.js";
export { createHybridRetriever } from "./hybrid/hybrid-retriever.js";
export type { MmrConfig } from "./hybrid/mmr.js";
export { applyMmr } from "./hybrid/mmr.js";
export type { TemporalDecayConfig } from "./hybrid/temporal-decay.js";
export { applyTemporalDecay } from "./hybrid/temporal-decay.js";
export type { Chunk, ChunkerConfig } from "./indexer/chunker.js";
export { chunk } from "./indexer/chunker.js";
export type { SqliteIndexerConfig } from "./indexer/sqlite-indexer.js";
export { createSqliteIndexer } from "./indexer/sqlite-indexer.js";
export { normalize, normalizeL2, normalizeMinMax, normalizeZScore } from "./normalize.js";
export type { QueryExpansionConfig } from "./query/expand.js";
export { expandQuery } from "./query/expand.js";
export type { VectorHit, VectorStore, VectorStoreConfig } from "./vector/sqlite-vec.js";
export { createVectorStore } from "./vector/sqlite-vec.js";
export type { VectorRetrieverConfig } from "./vector/vector-retriever.js";
export { createVectorRetriever } from "./vector/vector-retriever.js";
