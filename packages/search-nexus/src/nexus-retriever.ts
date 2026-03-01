/**
 * Nexus search retriever — reads from `GET /api/v2/search/query`.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { Retriever, SearchPage, SearchQuery } from "@koi/search-provider";
import { mapNexusHttpError } from "./http-errors.js";
import { mapNexusResult } from "./map-nexus-result.js";
import type { NexusSearchConfig } from "./nexus-search-config.js";
import { DEFAULT_TIMEOUT_MS } from "./nexus-search-config.js";
import type { NexusQueryResponse } from "./nexus-types.js";

export function createNexusRetriever(config: NexusSearchConfig): Retriever {
  const fetchFn = config.fetchFn ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    retrieve: async (query: SearchQuery): Promise<Result<SearchPage, KoiError>> => {
      const url = new URL("/api/v2/search/query", config.baseUrl);
      url.searchParams.set("q", query.text);
      url.searchParams.set("limit", String(query.limit));
      if (query.offset !== undefined) {
        url.searchParams.set("offset", String(query.offset));
      }
      if (query.cursor !== undefined) {
        url.searchParams.set("cursor", query.cursor);
      }
      if (query.minScore !== undefined) {
        url.searchParams.set("min_score", String(query.minScore));
      }

      try {
        const response = await fetchFn(url.toString(), {
          method: "GET",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          return { ok: false, error: mapNexusHttpError(response.status, body) };
        }

        const data = (await response.json()) as NexusQueryResponse;
        const results = data.hits.map(mapNexusResult);

        return {
          ok: true,
          value: {
            results,
            total: data.total,
            hasMore: data.has_more,
            ...(data.cursor !== undefined ? { cursor: data.cursor } : {}),
          },
        };
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "TimeoutError") {
          return {
            ok: false,
            error: {
              code: "TIMEOUT",
              message: `Nexus search query timed out after ${timeoutMs}ms`,
              retryable: RETRYABLE_DEFAULTS.TIMEOUT,
              retryAfterMs: 1000,
            },
          };
        }
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `Nexus search query failed: ${e instanceof Error ? e.message : String(e)}`,
            retryable: false,
            cause: e,
          },
        };
      }
    },
  };
}
