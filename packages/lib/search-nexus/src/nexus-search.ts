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
    // min_score is sent to Nexus above so the server applies the
    // threshold *before* paginating. We deliberately do NOT post-filter
    // client-side: trimming the page after pagination would silently
    // drop qualifying hits whose `cursor`/`hasMore` belong to the
    // server's view, producing inconsistent paging under version skew.
    // If a backend ignores `min_score`, the contract is violated and
    // should be fixed there, not papered over here.
    const hits = value.hits;

    const page: SearchPage<T> = {
      results: hits.map((hit) => ({
        id: hit.id,
        score: hit.score,
        content: hit.content,
        metadata: hit.metadata ?? {},
        source: hit.source ?? indexName,
        ...(hit.data !== undefined ? { data: hit.data } : {}),
      })),
      ...(value.total !== undefined ? { total: value.total } : {}),
      ...(value.cursor !== undefined ? { cursor: value.cursor } : {}),
      hasMore: value.cursor !== undefined,
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
