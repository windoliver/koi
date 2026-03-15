/**
 * Bounded-concurrency batch write for Nexus.
 *
 * Writes multiple entries in parallel with a configurable concurrency limit.
 * Returns succeeded/failed counts. Individual write failures do not abort
 * the entire batch — the helper always attempts every entry.
 */

import type { KoiError, Result } from "@koi/core";
import type { NexusClient } from "./types.js";

const DEFAULT_BATCH_CONCURRENCY = 10;

/** A single entry to write via Nexus. */
export interface BatchWriteEntry {
  readonly path: string;
  readonly data: unknown;
}

/** Outcome counters returned on success. */
export interface BatchWriteResult {
  readonly succeeded: number;
  readonly failed: number;
}

/**
 * Write multiple Nexus entries in bounded-concurrency batches.
 *
 * Unlike {@link batchRead}, individual write failures are tallied rather than
 * propagated — every entry is attempted regardless of per-item errors.
 */
export async function batchWrite(
  client: NexusClient,
  entries: readonly BatchWriteEntry[],
  options?: { readonly concurrency?: number },
): Promise<Result<BatchWriteResult, KoiError>> {
  const concurrency = Math.max(1, options?.concurrency ?? DEFAULT_BATCH_CONCURRENCY);
  // let justified: mutable counters for tracking write outcomes
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (entry) => {
        const result = await client.rpc<void>("write", {
          path: entry.path,
          data: entry.data,
        });
        return result;
      }),
    );

    for (const result of batchResults) {
      if (result.ok) {
        succeeded += 1;
      } else {
        failed += 1;
      }
    }
  }

  return { ok: true, value: { succeeded, failed } };
}
