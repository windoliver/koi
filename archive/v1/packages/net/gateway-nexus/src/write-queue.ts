/**
 * Coalescing write queue for Nexus-backed stores.
 *
 * Batches writes by path, deduplicating updates to the same key.
 * Immediate writes bypass coalescing for create/delete operations.
 */

import type { WriteQueueConfig } from "./config.js";
import { DEFAULT_WRITE_QUEUE_CONFIG } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WriteQueue {
  /** Enqueue a write. Set immediate=true for create/delete operations. */
  readonly enqueue: (path: string, data: string, immediate?: boolean) => void;
  /** Flush all pending writes. Returns when all writes complete. */
  readonly flush: () => Promise<void>;
  /** Stop the flush timer and flush remaining writes. */
  readonly dispose: () => Promise<void>;
  /** Number of pending entries in the queue. */
  readonly size: () => number;
}

type WriteFn = (path: string, data: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWriteQueue(
  writeFn: WriteFn,
  configOverrides?: Partial<WriteQueueConfig>,
): WriteQueue {
  const config: WriteQueueConfig = { ...DEFAULT_WRITE_QUEUE_CONFIG, ...configOverrides };
  const pending = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | undefined;

  async function flushAll(): Promise<void> {
    if (pending.size === 0) return;
    // Snapshot and clear to allow new enqueues during flush
    const entries = [...pending.entries()];
    pending.clear();
    // Fire all writes concurrently
    await Promise.allSettled(entries.map(([path, data]) => writeFn(path, data)));
  }

  function startTimer(): void {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      void flushAll();
    }, config.flushIntervalMs);
  }

  function stopTimer(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return {
    enqueue(path: string, data: string, immediate?: boolean): void {
      if (immediate === true) {
        // Bypass coalescing — fire immediately, don't await
        pending.delete(path);
        void writeFn(path, data).catch(() => {
          // Errors tracked via writeFn's degradation state
        });
        return;
      }
      if (pending.size >= config.maxQueueSize) {
        // Drop oldest entry to prevent unbounded growth
        const firstKey = pending.keys().next().value;
        if (firstKey !== undefined) {
          pending.delete(firstKey);
        }
      }
      pending.set(path, data);
      startTimer();
    },

    async flush(): Promise<void> {
      await flushAll();
    },

    async dispose(): Promise<void> {
      stopTimer();
      await flushAll();
    },

    size(): number {
      return pending.size;
    },
  };
}
