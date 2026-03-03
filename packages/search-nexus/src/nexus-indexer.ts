/**
 * Nexus search indexer — writes to `POST /api/v2/search/index`
 * and removes via `POST /api/v2/search/refresh`.
 *
 * Internal: consumed by the composite factory, not exported directly.
 */

import type { KoiError, Result } from "@koi/core";
import type { NexusRestClient } from "@koi/nexus-client";
import type { IndexDocument, Indexer } from "@koi/search-provider";
import type { NexusSearchConfig } from "./nexus-search-config.js";
import { DEFAULT_MAX_BATCH_SIZE } from "./nexus-search-config.js";

function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const count = Math.ceil(items.length / size);
  return Array.from({ length: count }, (_, i) => items.slice(i * size, i * size + size));
}

export function createNexusIndexer(client: NexusRestClient, config: NexusSearchConfig): Indexer {
  const maxBatchSize = config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;

  return {
    index: async (documents: readonly IndexDocument[]): Promise<Result<void, KoiError>> => {
      if (documents.length === 0) {
        return { ok: true, value: undefined };
      }

      const batches = chunk(documents, maxBatchSize);

      for (const batch of batches) {
        const body = batch.map((doc) => ({
          id: doc.id,
          content: doc.content,
          metadata: doc.metadata ?? {},
          ...(doc.embedding !== undefined ? { embedding: doc.embedding } : {}),
        }));

        const result = await client.request<unknown>("POST", "/api/v2/search/index", {
          documents: body,
        });

        if (!result.ok) {
          return result;
        }
      }

      return { ok: true, value: undefined };
    },

    remove: async (ids: readonly string[]): Promise<Result<void, KoiError>> => {
      if (ids.length === 0) {
        return { ok: true, value: undefined };
      }

      const result = await client.request<unknown>("POST", "/api/v2/search/refresh", {
        remove: ids,
      });

      if (!result.ok) {
        return result;
      }

      return { ok: true, value: undefined };
    },
  };
}
