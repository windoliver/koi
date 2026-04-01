/**
 * Write-behind buffer for ATIF document store.
 *
 * Accumulates RichTrajectoryStep entries in memory and flushes to the
 * backing TrajectoryDocumentStore in batches. Designed for the hot path
 * (wrapModelCall / wrapToolCall) where fire-and-forget semantics are needed.
 *
 * Call flush() before reflection or session end to ensure all data is persisted.
 */

import type { RichTrajectoryStep, TrajectoryDocumentStore } from "@koi/core/rich-trajectory";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 60_000;

export interface AtifWriteBehindBufferConfig {
  /** Number of steps to accumulate before auto-flushing. Default: 50. */
  readonly batchSize?: number;
  /** Auto-flush interval in milliseconds. Default: 60000 (1 minute). */
  readonly flushIntervalMs?: number;
  /** Callback for flush errors (fire-and-forget flushes). */
  readonly onFlushError?: (error: unknown, docId: string) => void;
}

export interface AtifWriteBehindBuffer {
  /** Add a step to the buffer (non-blocking). Triggers auto-flush if batch size reached. */
  readonly append: (docId: string, step: RichTrajectoryStep) => void;
  /** Flush all buffered steps to the store. Call before reflection or session end. */
  readonly flush: (docId?: string) => Promise<void>;
  /** Get the number of buffered steps for a document. */
  readonly pending: (docId: string) => number;
  /** Stop the auto-flush timer. */
  readonly dispose: () => void;
}

/** Create a write-behind buffer wrapping a TrajectoryDocumentStore. */
export function createAtifWriteBehindBuffer(
  store: TrajectoryDocumentStore,
  config: AtifWriteBehindBufferConfig = {},
): AtifWriteBehindBuffer {
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  const flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const onFlushError = config.onFlushError ?? defaultFlushErrorHandler;

  const buffers = new Map<string, RichTrajectoryStep[]>();

  // Auto-flush timer
  const timer = setInterval(() => {
    void flushAll();
  }, flushIntervalMs);

  async function flushDoc(docId: string): Promise<void> {
    const steps = buffers.get(docId);
    if (steps === undefined || steps.length === 0) return;

    // Take the steps and clear the buffer before async write
    const toFlush = [...steps];
    steps.length = 0;

    await store.append(docId, toFlush);
  }

  async function flushAll(): Promise<void> {
    const docIds = [...buffers.keys()];
    for (const docId of docIds) {
      try {
        await flushDoc(docId);
      } catch (e: unknown) {
        onFlushError(e, docId);
      }
    }
  }

  return {
    append(docId: string, step: RichTrajectoryStep): void {
      const existing = buffers.get(docId);
      if (existing !== undefined) {
        existing.push(step);
      } else {
        buffers.set(docId, [step]);
      }

      // Auto-flush when batch size reached (fire-and-forget)
      const buffer = buffers.get(docId);
      if (buffer !== undefined && buffer.length >= batchSize) {
        void flushDoc(docId).catch((e: unknown) => {
          onFlushError(e, docId);
        });
      }
    },

    async flush(docId?: string): Promise<void> {
      if (docId !== undefined) {
        await flushDoc(docId);
      } else {
        await flushAll();
      }
    },

    pending(docId: string): number {
      return buffers.get(docId)?.length ?? 0;
    },

    dispose(): void {
      clearInterval(timer);
    },
  };
}

function defaultFlushErrorHandler(error: unknown, docId: string): void {
  console.warn(`ACE: ATIF buffer flush failed for doc ${docId}`, error);
}
