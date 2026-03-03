/**
 * Nexus search retriever — reads from `GET /api/v2/search/query`.
 *
 * Internal: consumed by the composite factory, not exported directly.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { NexusRestClient } from "@koi/nexus-client";
import type { Retriever, SearchPage, SearchQuery } from "@koi/search-provider";
import { mapNexusResult } from "./map-nexus-result.js";
import type { NexusSearchConfig } from "./nexus-search-config.js";
import { DEFAULT_LIMIT, DEFAULT_MIN_SCORE } from "./nexus-search-config.js";
import { parseNexusQueryResponse } from "./parse-response.js";

export function createNexusRetriever(
  client: NexusRestClient,
  config: NexusSearchConfig,
): Retriever {
  const defaultLimit = config.defaultLimit ?? DEFAULT_LIMIT;
  const defaultMinScore = config.minScore ?? DEFAULT_MIN_SCORE;

  return {
    retrieve: async (query: SearchQuery): Promise<Result<SearchPage, KoiError>> => {
      if (query.filter !== undefined) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Nexus search does not support filters",
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }

      const limit = query.limit ?? defaultLimit;
      const minScore = query.minScore ?? defaultMinScore;

      const params = new URLSearchParams();
      params.set("q", query.text);
      params.set("limit", String(limit));
      if (query.offset !== undefined) {
        params.set("offset", String(query.offset));
      }
      if (query.cursor !== undefined) {
        params.set("cursor", query.cursor);
      }
      if (minScore > 0) {
        params.set("min_score", String(minScore));
      }

      const result = await client.request<unknown>(
        "GET",
        `/api/v2/search/query?${params.toString()}`,
      );

      if (!result.ok) {
        return result;
      }

      const parsed = parseNexusQueryResponse(result.value);
      if (!parsed.ok) {
        return parsed;
      }

      const data = parsed.value;
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
    },
  };
}
