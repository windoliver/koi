/**
 * createNexusSearch — composite factory for Nexus search adapter.
 *
 * Returns a NexusSearch with retriever, indexer, health check, stats, and reindex.
 * All operations are wrapped with Result-aware retry for transient failures.
 */

import type { KoiError, Result } from "@koi/core";
import {
  computeBackoff,
  DEFAULT_RETRY_CONFIG,
  isRetryable,
  type RetryConfig,
  sleep,
} from "@koi/errors";
import { createNexusRestClient } from "@koi/nexus-client";
import type { IndexDocument, SearchQuery } from "@koi/search-provider";
import { createNexusIndexer } from "./nexus-indexer.js";
import { createNexusRetriever } from "./nexus-retriever.js";
import type { NexusSearchConfig } from "./nexus-search-config.js";
import { DEFAULT_TIMEOUT_MS } from "./nexus-search-config.js";
import type { NexusSearch, SearchHealth, SearchStats } from "./nexus-search-types.js";
import { parseNexusHealthResponse, parseNexusStatsResponse } from "./parse-response.js";
import { validateNexusSearchConfig } from "./validate-config.js";

/**
 * Wraps a Result-returning async function with retry logic.
 * Retries when result.ok === false and the error is retryable.
 */
async function withResultRetry<T>(
  fn: () => Promise<Result<T, KoiError>>,
  retryConfig: RetryConfig,
): Promise<Result<T, KoiError>> {
  // let: reassigned on each retry attempt
  let lastResult: Result<T, KoiError> = await fn();

  // let: loop counter
  for (let attempt = 0; attempt < retryConfig.maxRetries; attempt++) {
    if (lastResult.ok || !isRetryable(lastResult.error)) {
      return lastResult;
    }

    const delay = computeBackoff(attempt, retryConfig, lastResult.error.retryAfterMs);
    await sleep(delay);

    lastResult = await fn();
  }

  return lastResult;
}

export function createNexusSearch(config: NexusSearchConfig): NexusSearch {
  const validation = validateNexusSearchConfig(config);
  if (!validation.ok) {
    throw new Error(validation.error.message);
  }

  const retryConfig: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...config.retry,
  };

  const client = createNexusRestClient({
    baseUrl: config.baseUrl,
    authToken: config.apiKey,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetch: config.fetchFn,
  });

  const retriever = createNexusRetriever(client, config);
  const indexer = createNexusIndexer(client, config);

  const healthCheck = async (): Promise<Result<SearchHealth, KoiError>> => {
    const result = await client.request<unknown>("GET", "/api/v2/search/health");
    if (!result.ok) {
      return result;
    }

    const parsed = parseNexusHealthResponse(result.value);
    if (!parsed.ok) {
      return parsed;
    }

    const data = parsed.value;
    return {
      ok: true,
      value: {
        healthy: data.healthy,
        ...(data.index_name !== undefined ? { indexName: data.index_name } : {}),
        ...(data.message !== undefined ? { message: data.message } : {}),
      },
    };
  };

  const getStats = async (): Promise<Result<SearchStats, KoiError>> => {
    const result = await client.request<unknown>("GET", "/api/v2/search/stats");
    if (!result.ok) {
      return result;
    }

    const parsed = parseNexusStatsResponse(result.value);
    if (!parsed.ok) {
      return parsed;
    }

    const data = parsed.value;
    return {
      ok: true,
      value: {
        documentCount: data.document_count,
        ...(data.index_size_bytes !== undefined ? { indexSizeBytes: data.index_size_bytes } : {}),
        ...(data.last_refreshed !== undefined ? { lastRefreshed: data.last_refreshed } : {}),
      },
    };
  };

  const reindex = async (): Promise<Result<void, KoiError>> => {
    const result = await client.request<unknown>("POST", "/api/v2/search/reindex");
    if (!result.ok) {
      return result;
    }
    return { ok: true, value: undefined };
  };

  return {
    retriever: {
      retrieve: (query: SearchQuery) =>
        withResultRetry(() => retriever.retrieve(query), retryConfig),
    },
    indexer: {
      index: (docs: readonly IndexDocument[]) =>
        withResultRetry(() => indexer.index(docs), retryConfig),
      remove: (ids: readonly string[]) => withResultRetry(() => indexer.remove(ids), retryConfig),
    },
    healthCheck: () => withResultRetry(healthCheck, retryConfig),
    getStats: () => withResultRetry(getStats, retryConfig),
    reindex: () => withResultRetry(reindex, retryConfig),
    close: () => {
      /* no-op: REST client has no persistent connections */
    },
  };
}
