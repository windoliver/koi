/**
 * Nexus-backed AuditSink — batched writes with interval + size triggers.
 *
 * Each audit entry is written to Nexus as a separate JSON file at:
 *   {basePath}/{sessionId}/{timestamp}-{turnIndex}-{kind}.json
 *
 * Errors from `log()` are fire-and-forget (swallowed). Errors from `flush()`
 * propagate to the caller so middleware can enforce its error policy.
 */

import type { AuditEntry, AuditSink } from "@koi/core";
import type { RetryConfig } from "@koi/errors";
import { DEFAULT_RETRY_CONFIG, swallowError, withRetry } from "@koi/errors";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusClient } from "@koi/nexus-client";
import type { NexusAuditSinkConfig } from "./config.js";
import {
  DEFAULT_BASE_PATH,
  DEFAULT_BATCH_SIZE,
  DEFAULT_FLUSH_INTERVAL_MS,
  validateNexusAuditSinkConfig,
} from "./config.js";

/**
 * Creates an AuditSink that writes entries to Nexus in batches.
 *
 * @throws On invalid config (VALIDATION error)
 */
export function createNexusAuditSink(config: NexusAuditSinkConfig): AuditSink {
  const validation = validateNexusAuditSinkConfig(config);
  if (!validation.ok) {
    throw new Error(validation.error.message, { cause: validation.error });
  }

  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  const flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const retryConfig: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config.retry };

  const client: NexusClient = createNexusClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: config.fetch,
  });

  // Internal mutable state — encapsulated in closure, never exposed.
  // `let` justified: buffer is swapped atomically on flush; timer/flushing are lifecycle flags.
  // `let` justified: monotonic counter prevents same-millisecond path collisions.
  let buffer: AuditEntry[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let flushing = false;
  let entrySeq = 0;

  function computeEntryPath(entry: AuditEntry): string {
    const safeSessionId = entry.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const seq = entrySeq++;
    return `${basePath}/${safeSessionId}/${entry.timestamp}-${entry.turnIndex}-${entry.kind}-${seq}.json`;
  }

  async function writeEntry(entry: AuditEntry, path: string): Promise<void> {
    const result = await client.rpc("write", {
      path,
      content: JSON.stringify(entry),
    });
    if (!result.ok) {
      throw new Error(result.error.message, { cause: result.error });
    }
  }

  async function flushBuffer(): Promise<void> {
    if (buffer.length === 0 || flushing) return;

    flushing = true;
    const batch = buffer;
    buffer = [];

    try {
      const results = await Promise.allSettled(
        batch.map((entry) => {
          const path = computeEntryPath(entry);
          return withRetry(() => writeEntry(entry, path), retryConfig);
        }),
      );

      // Re-enqueue failed entries so they can be retried on next flush
      const failedEntries = batch.filter((_, i) => results[i]?.status === "rejected");
      if (failedEntries.length > 0) {
        buffer = [...failedEntries, ...buffer];
      }

      const firstRejected = results.find(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (firstRejected) {
        throw new Error("Failed to write audit entry", { cause: firstRejected.reason });
      }
    } finally {
      flushing = false;
    }
  }

  function ensureTimer(): void {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      void flushBuffer().catch((error: unknown) => {
        swallowError(error, {
          package: "audit-sink-nexus",
          operation: "interval-flush",
        });
      });
    }, flushIntervalMs);
    // Don't prevent process exit if consumer forgets to call flush()
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  }

  const log = async (entry: AuditEntry): Promise<void> => {
    buffer = [...buffer, entry];
    ensureTimer();

    if (buffer.length >= batchSize) {
      // Fire-and-forget — errors surface on flush()
      void flushBuffer().catch((error: unknown) => {
        swallowError(error, {
          package: "audit-sink-nexus",
          operation: "batch-flush",
        });
      });
    }
  };

  const flush = async (): Promise<void> => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    await flushBuffer();
  };

  const query = async (sessionId: string): Promise<readonly AuditEntry[]> => {
    // Flush pending entries before querying
    await flush();

    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const sessionPath = `${basePath}/${safeSessionId}`;

    const listResult = await client.rpc("list", { path: sessionPath });
    if (!listResult.ok) return [];

    const files = listResult.value as readonly { readonly path: string }[];
    const entries: AuditEntry[] = [];

    for (const file of files) {
      const readResult = await client.rpc("read", { path: file.path });
      if (readResult.ok && typeof readResult.value === "string") {
        try {
          entries.push(JSON.parse(readResult.value) as AuditEntry);
        } catch {
          // Skip malformed entries
        }
      }
    }

    return entries;
  };

  return { log, flush, query };
}
