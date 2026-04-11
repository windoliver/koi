/**
 * Bounded ring buffer for audit entries.
 *
 * The agent loop is never blocked — entries are enqueued and drained
 * asynchronously. On overflow, the oldest entry is dropped and onOverflow fires.
 */

import type { AuditEntry, AuditSink } from "@koi/core";
import { swallowError } from "@koi/errors";

export interface BoundedQueueConfig {
  readonly sink: AuditSink;
  readonly maxQueueDepth: number;
  /**
   * Called immediately before sink.log() — transforms the entry (e.g. hash-chain signing).
   * Runs at drain time so only entries that survive eviction enter the chain.
   */
  readonly stampEntry?: (entry: AuditEntry) => AuditEntry;
  readonly onOverflow?: (entry: AuditEntry, droppedCount: number) => void;
  readonly onError?: (error: unknown, entry: AuditEntry) => void;
}

export interface BoundedQueue {
  readonly enqueue: (entry: AuditEntry) => void;
  readonly flush: () => Promise<void>;
  readonly droppedCount: () => number;
  /** True when the next enqueue will evict the oldest entry. */
  readonly isFull: () => boolean;
}

export function createBoundedQueue(config: BoundedQueueConfig): BoundedQueue {
  const { sink, maxQueueDepth, stampEntry, onOverflow, onError } = config;

  // Mutable internal state — never exposed
  const queue: AuditEntry[] = [];
  // let justified: tracks drop count across the queue lifetime
  let dropped = 0;
  // let justified: prevents concurrent drain loops
  let draining = false;
  // let justified: tracks the current drain loop for flush() coordination
  let drainPromise: Promise<void> | null = null;

  function handleSinkError(error: unknown, entry: AuditEntry): void {
    if (onError) {
      onError(error, entry);
    } else {
      swallowError(error, { package: "middleware-audit", operation: "sink.log" });
    }
  }

  async function runDrainLoop(): Promise<void> {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry !== undefined) {
        // Apply stampEntry at drain time — only entries that survived eviction enter the chain
        const toLog = stampEntry !== undefined ? stampEntry(entry) : entry;
        // Pass toLog (the stamped version) to onError so recovery hooks see the signed fields
        await sink.log(toLog).catch((err: unknown) => handleSinkError(err, toLog));
      }
    }
    draining = false;
    drainPromise = null;
    // Items may have been enqueued during the last await — restart if so
    if (queue.length > 0) {
      draining = true;
      drainPromise = runDrainLoop();
    }
  }

  function enqueue(entry: AuditEntry): void {
    if (queue.length >= maxQueueDepth) {
      // Drop the oldest entry to make room (ring buffer semantics)
      queue.shift();
      dropped++;
      onOverflow?.(entry, dropped);
    }
    queue.push(entry);
    if (!draining) {
      draining = true;
      drainPromise = runDrainLoop();
    }
  }

  async function flush(): Promise<void> {
    // Wait for the ongoing drain loop to complete — do NOT run a parallel loop
    if (drainPromise !== null) {
      await drainPromise;
    }
    // Drain any items enqueued while we were waiting
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry !== undefined) {
        // Apply stampEntry at drain time, consistent with runDrainLoop
        const toLog = stampEntry !== undefined ? stampEntry(entry) : entry;
        // Pass toLog (the stamped version) to onError so recovery hooks see the signed fields
        await sink.log(toLog).catch((err: unknown) => handleSinkError(err, toLog));
      }
    }
    await sink.flush?.();
  }

  return {
    enqueue,
    flush,
    droppedCount: () => dropped,
    isFull: () => queue.length >= maxQueueDepth,
  };
}
