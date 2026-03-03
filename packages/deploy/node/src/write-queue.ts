/**
 * Write queue — batches checkpoint writes to reduce SQLite transaction overhead.
 *
 * Only keeps the latest checkpoint per agent (overwrites on enqueue).
 * Flushes on a configurable interval and on dispose.
 */

import type { SessionCheckpoint } from "@koi/core";
import type { NodeSessionStore } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WriteQueueConfig {
  /** Milliseconds between automatic flushes. Default: 5000. */
  readonly flushIntervalMs: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface WriteQueue {
  /** Enqueue a checkpoint for batched write. Keeps only the latest per agent. */
  readonly enqueue: (agentId: string, checkpoint: SessionCheckpoint) => void;
  /** Flush all pending checkpoints to the store immediately. */
  readonly flush: () => Promise<void>;
  /** Stop the auto-flush timer and flush remaining checkpoints. */
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWriteQueue(
  store: NodeSessionStore,
  config?: Partial<WriteQueueConfig>,
): WriteQueue {
  const flushIntervalMs = config?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const pending = new Map<string, SessionCheckpoint>();
  let disposed = false;

  async function doFlush(): Promise<void> {
    if (pending.size === 0) return;

    // Snapshot and clear before writing to avoid re-entrancy issues
    const entries = [...pending.entries()];
    pending.clear();

    for (const [_agentId, checkpoint] of entries) {
      await store.saveCheckpoint(checkpoint);
    }
  }

  const timer = setInterval(() => {
    void doFlush();
  }, flushIntervalMs);

  return {
    enqueue(agentId: string, checkpoint: SessionCheckpoint): void {
      if (disposed) return;
      pending.set(agentId, checkpoint);
    },

    async flush(): Promise<void> {
      await doFlush();
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      await doFlush();
    },
  };
}
