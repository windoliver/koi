/**
 * Bounded-concurrency batch read for Nexus.
 *
 * Reads multiple paths in parallel with a configurable concurrency limit.
 * Returns a map of path → content for paths that were successfully read.
 * Skips paths that return NOT_FOUND or EXTERNAL errors.
 */

import type { KoiError, Result } from "@koi/core";
import type { NexusClient } from "./types.js";

const DEFAULT_BATCH_CONCURRENCY = 10;

/**
 * Read multiple Nexus paths in bounded-concurrency batches.
 *
 * Paths that fail with NOT_FOUND or EXTERNAL are silently skipped.
 * Other errors cause the entire batch to fail.
 */
export async function batchRead(
  client: NexusClient,
  paths: readonly string[],
  options?: { readonly concurrency?: number },
): Promise<Result<ReadonlyMap<string, string>, KoiError>> {
  const concurrency = Math.max(1, options?.concurrency ?? DEFAULT_BATCH_CONCURRENCY);
  const results = new Map<string, string>();

  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (path) => {
        const result = await client.rpc<string>("read", { path });
        return { path, result };
      }),
    );

    for (const { path, result } of batchResults) {
      if (result.ok) {
        results.set(path, result.value);
      } else if (result.error.code !== "NOT_FOUND" && result.error.code !== "EXTERNAL") {
        // Propagate non-skip errors
        return { ok: false, error: result.error } as const;
      }
      // NOT_FOUND / EXTERNAL → skip silently
    }
  }

  return { ok: true, value: results };
}
