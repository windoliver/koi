/**
 * Public types for the Nexus search composite.
 */

import type { KoiError, Result } from "@koi/core";
import type { Indexer, Retriever } from "@koi/search-provider";

export interface SearchHealth {
  readonly healthy: boolean;
  readonly indexName?: string | undefined;
  readonly message?: string | undefined;
}

export interface SearchStats {
  readonly documentCount: number;
  readonly indexSizeBytes?: number | undefined;
  readonly lastRefreshed?: string | undefined;
}

export interface NexusSearch {
  readonly retriever: Retriever;
  readonly indexer: Indexer;
  readonly healthCheck: () => Promise<Result<SearchHealth, KoiError>>;
  readonly getStats: () => Promise<Result<SearchStats, KoiError>>;
  readonly reindex: () => Promise<Result<void, KoiError>>;
  readonly close: () => void;
}
