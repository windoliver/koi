/**
 * Bounded-concurrency batch write for Nexus.
 *
 * Writes multiple entries in parallel with a configurable concurrency limit.
 * Returns succeeded/failed counts. Individual write failures do not abort
 * the entire batch — the helper always attempts every entry.
 *
 * Retryable errors (e.g. HTTP 429 rate limit) are retried with exponential
 * backoff up to MAX_RETRIES times before being counted as failed.
 */

import type { KoiError, Result } from "@koi/core";
import type { NexusClient } from "./types.js";

const DEFAULT_BATCH_CONCURRENCY = 10;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;

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
 * Writes a single entry with retry and exponential backoff for retryable errors.
 */
async function writeWithRetry(
  client: NexusClient,
  entry: BatchWriteEntry,
): Promise<Result<void, KoiError>> {
  const content = typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await client.rpc<void>("write", { path: entry.path, content });
    if (result.ok) return result;
    // Retry if error is retryable and we have attempts left
    if (result.error.retryable === true && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, INITIAL_BACKOFF_MS * 2 ** attempt));
      continue;
    }
    return result;
  }
  // Unreachable, but satisfies TypeScript
  return {
    ok: false,
    error: { code: "EXTERNAL", message: "max retries exceeded", retryable: false },
  };
}

/**
 * Write multiple Nexus entries in bounded-concurrency batches.
 *
 * Unlike {@link batchRead}, individual write failures are tallied rather than
 * propagated — every entry is attempted regardless of per-item errors.
 * Retryable errors (HTTP 429) are retried with exponential backoff.
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
    const batchResults = await Promise.all(batch.map((entry) => writeWithRetry(client, entry)));

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
