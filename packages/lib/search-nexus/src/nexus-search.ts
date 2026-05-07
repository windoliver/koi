/**
 * Nexus-backed SearchBackend implementation.
 *
 * Translates the L0 SearchBackend contract (Retriever + Indexer) into
 * Nexus search RPC method calls. Stateless adapter — owns no state, the
 * caller manages the transport lifecycle.
 */

import type {
  IndexDocument,
  KoiError,
  Result,
  SearchBackend,
  SearchPage,
  SearchQuery,
} from "@koi/core";
import { DEFAULT_SEARCH_LIMIT } from "@koi/core";
import {
  DEFAULT_NEXUS_SEARCH_CONFIG,
  type NexusSearchConfig,
  validateNexusSearchConfig,
} from "./config.js";

interface NexusSearchHit<T = unknown> {
  readonly id: string;
  readonly score: number;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly source?: string;
  readonly data?: T;
}

interface NexusSearchResponse<T = unknown> {
  readonly hits: readonly NexusSearchHit<T>[];
  readonly total?: number;
  readonly cursor?: string;
}

export function createNexusSearch<T = unknown>(config: NexusSearchConfig): SearchBackend<T> {
  const validation = validateNexusSearchConfig(config);
  if (!validation.ok) {
    throw new Error(validation.error.message, { cause: validation.error });
  }

  const transport = config.transport;
  const indexName = config.indexName ?? DEFAULT_NEXUS_SEARCH_CONFIG.indexName;
  const maxBatchSize = config.maxBatchSize ?? DEFAULT_NEXUS_SEARCH_CONFIG.maxBatchSize;

  async function retrieve(query: SearchQuery): Promise<Result<SearchPage<T>, KoiError>> {
    const limit = query.limit > 0 ? query.limit : DEFAULT_SEARCH_LIMIT;
    const params: Record<string, unknown> = {
      index: indexName,
      text: query.text,
      limit,
      ...(query.filter !== undefined ? { filter: query.filter } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      ...(query.minScore !== undefined ? { min_score: query.minScore } : {}),
    };

    const result = await transport.call<NexusSearchResponse<T>>("search_retrieve", params);
    if (!result.ok) return result;

    const value = result.value;
    // min_score is sent to Nexus to filter server-side before pagination.
    // We also defensively drop sub-threshold hits client-side under
    // version skew (older Nexus may ignore the parameter). When that
    // post-filter trims anything, server-supplied pagination metadata
    // (cursor / hasMore / total) belongs to a different (broader)
    // result set, so we either drop it or fail closed depending on
    // whether the caller would otherwise paginate into hidden pages.
    const minScore = query.minScore;
    const filtered =
      minScore !== undefined ? value.hits.filter((h) => h.score >= minScore) : value.hits;
    const trimmedByClient = minScore !== undefined && filtered.length !== value.hits.length;

    const page: SearchPage<T> = {
      results: filtered.map((hit) => ({
        id: hit.id,
        score: hit.score,
        content: hit.content,
        metadata: hit.metadata ?? {},
        source: hit.source ?? indexName,
        ...(hit.data !== undefined ? { data: hit.data } : {}),
      })),
      // total reflects the server's unfiltered set; suppress it when
      // we trimmed locally so callers don't display a count that
      // doesn't match results.length.
      ...(value.total !== undefined && !trimmedByClient ? { total: value.total } : {}),
      // cursor/hasMore are only safe to surface when the server
      // honored min_score (no client-side trim). Otherwise the next
      // page would belong to the broader server result set.
      ...(value.cursor !== undefined && !trimmedByClient ? { cursor: value.cursor } : {}),
      hasMore: value.cursor !== undefined && !trimmedByClient,
    };

    return { ok: true, value: page };
  }

  /**
   * Bulk-index documents in batches of at most `maxBatchSize`.
   *
   * Partial-failure semantics: `search_index` is required to be **idempotent
   * by document id** — re-sending a document with the same id replaces the
   * existing entry rather than duplicating it. This means callers can safely
   * retry the entire input on a partial failure without producing drift.
   *
   * On failure, the returned KoiError context records how many documents
   * were already committed, the failed-batch range, and the total input
   * size, so callers can decide whether to retry the whole call (idempotent)
   * or just the failed slice.
   */
  async function index(documents: readonly IndexDocument<T>[]): Promise<Result<void, KoiError>> {
    if (documents.length === 0) return { ok: true, value: undefined };

    for (let i = 0; i < documents.length; i += maxBatchSize) {
      const batch = documents.slice(i, i + maxBatchSize);
      const result = await transport.call<unknown>("search_index", {
        index: indexName,
        documents: batch,
      });
      if (!result.ok) {
        return {
          ok: false,
          error: {
            ...result.error,
            context: {
              ...(result.error.context ?? {}),
              committedCount: i,
              failedBatchStart: i,
              failedBatchEnd: i + batch.length,
              totalCount: documents.length,
              retryHint:
                "search_index is idempotent by document id; retrying the full input is safe",
            },
          },
        };
      }
    }

    return { ok: true, value: undefined };
  }

  async function remove(ids: readonly string[]): Promise<Result<void, KoiError>> {
    if (ids.length === 0) return { ok: true, value: undefined };

    const result = await transport.call<unknown>("search_remove", {
      index: indexName,
      ids,
    });
    if (!result.ok) return result;

    return { ok: true, value: undefined };
  }

  return { retrieve, index, remove };
}
