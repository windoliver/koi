/**
 * K8s-style three-data-structure reconcile queue.
 *
 * Provides deduplication and dirty-tracking for reconciliation keys:
 * - `queue`: ordered list of keys awaiting processing (FIFO)
 * - `processing`: set of keys currently being processed
 * - `dirty`: set of keys re-enqueued during processing (buffer until complete)
 *
 * This prevents duplicate reconcile calls while still catching events that
 * arrive during an in-flight reconcile pass.
 */

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

export interface ReconcileQueue<K extends string> {
  /** Add a key to the queue. Deduplicates against queue + processing (buffers as dirty). */
  readonly enqueue: (key: K) => void;
  /** Remove and return the next key for processing. Returns undefined if empty. */
  readonly dequeue: () => K | undefined;
  /** Mark a key as done processing. If dirty, re-enqueues at queue tail. */
  readonly complete: (key: K) => void;
  /** Remove a key from all data structures (queue, processing, dirty). */
  readonly remove: (key: K) => void;
  /** Total keys across queue + processing (excludes dirty, which is a buffer). */
  readonly size: () => number;
  /** Check if key is in any state (queue, processing, or dirty). */
  readonly has: (key: K) => boolean;
  /** Clear all data structures. */
  readonly clear: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReconcileQueue<K extends string>(): ReconcileQueue<K> {
  const queue: K[] = []; // let-equivalent: mutated via push/splice for FIFO
  const processing = new Set<K>();
  const dirty = new Set<K>();

  function enqueue(key: K): void {
    // If currently processing, buffer as dirty instead of re-enqueuing
    if (processing.has(key)) {
      dirty.add(key);
      return;
    }
    // Skip if already in queue
    if (queue.includes(key)) return;
    queue.push(key);
  }

  function dequeue(): K | undefined {
    const key = queue.shift();
    if (key !== undefined) {
      processing.add(key);
    }
    return key;
  }

  function complete(key: K): void {
    processing.delete(key);
    // If re-enqueued during processing, move to queue tail
    if (dirty.has(key)) {
      dirty.delete(key);
      queue.push(key);
    }
  }

  function remove(key: K): void {
    const idx = queue.indexOf(key);
    if (idx !== -1) queue.splice(idx, 1);
    processing.delete(key);
    dirty.delete(key);
  }

  function size(): number {
    return queue.length + processing.size;
  }

  function has(key: K): boolean {
    return queue.includes(key) || processing.has(key) || dirty.has(key);
  }

  function clear(): void {
    queue.length = 0;
    processing.clear();
    dirty.clear();
  }

  return { enqueue, dequeue, complete, remove, size, has, clear };
}
