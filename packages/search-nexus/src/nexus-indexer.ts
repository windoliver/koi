/**
 * Nexus search indexer — writes to `POST /api/v2/search/index`
 * and removes via `POST /api/v2/search/refresh`.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { IndexDocument, Indexer } from "@koi/search-provider";
import { mapNexusHttpError } from "./http-errors.js";
import type { NexusSearchConfig } from "./nexus-search-config.js";
import { DEFAULT_TIMEOUT_MS } from "./nexus-search-config.js";

export function createNexusIndexer(config: NexusSearchConfig): Indexer {
  const fetchFn = config.fetchFn ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    index: async (documents: readonly IndexDocument[]): Promise<Result<void, KoiError>> => {
      const body = documents.map((doc) => ({
        id: doc.id,
        content: doc.content,
        metadata: doc.metadata ?? {},
        ...(doc.embedding !== undefined ? { embedding: doc.embedding } : {}),
      }));

      try {
        const response = await fetchFn(new URL("/api/v2/search/index", config.baseUrl).toString(), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ documents: body }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          return { ok: false, error: mapNexusHttpError(response.status, text) };
        }

        return { ok: true, value: undefined };
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "TimeoutError") {
          return {
            ok: false,
            error: {
              code: "TIMEOUT",
              message: `Nexus index request timed out after ${timeoutMs}ms`,
              retryable: RETRYABLE_DEFAULTS.TIMEOUT,
              retryAfterMs: 1000,
            },
          };
        }
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `Nexus index request failed: ${e instanceof Error ? e.message : String(e)}`,
            retryable: false,
            cause: e,
          },
        };
      }
    },

    remove: async (ids: readonly string[]): Promise<Result<void, KoiError>> => {
      try {
        const response = await fetchFn(
          new URL("/api/v2/search/refresh", config.baseUrl).toString(),
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({ remove: ids }),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          return { ok: false, error: mapNexusHttpError(response.status, text) };
        }

        return { ok: true, value: undefined };
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "TimeoutError") {
          return {
            ok: false,
            error: {
              code: "TIMEOUT",
              message: `Nexus remove request timed out after ${timeoutMs}ms`,
              retryable: RETRYABLE_DEFAULTS.TIMEOUT,
              retryAfterMs: 1000,
            },
          };
        }
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `Nexus remove request failed: ${e instanceof Error ? e.message : String(e)}`,
            retryable: false,
            cause: e,
          },
        };
      }
    },
  };
}
