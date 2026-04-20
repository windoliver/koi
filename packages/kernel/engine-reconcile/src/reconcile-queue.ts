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
 *
 * Performance:
 * - enqueue / dequeue / has / remove are all O(1) amortized
 * - `queue` uses a head-pointer ring-ish semantics (never shifts); a sibling
 *   `queuedSet` mirrors membership for O(1) dedup in enqueue/has
 * - the underlying array is compacted when the head pointer exceeds half the
 *   array length, keeping memory bounded proportional to actual in-flight size
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
  // Array + head pointer gives amortized O(1) FIFO without paying O(n) shift().
  // let justified: queueStorage is mutated in place for FIFO; head advances on dequeue.
  let queueStorage: (K | undefined)[] = [];
  // let justified: head pointer into queueStorage; entries at indices < head are dead.
  let head = 0;
  // Sibling Set mirrors queueStorage membership for O(1) `queue.includes()` equivalent.
  const queuedSet = new Set<K>();
  const processing = new Set<K>();
  const dirty = new Set<K>();

  /**
   * Compact the storage when the dead prefix grows large, to bound memory.
   * Amortized O(1) per dequeue because we only compact when dead ≥ live.
   */
  function maybeCompact(): void {
    if (head > 0 && head >= queueStorage.length - head) {
      queueStorage = queueStorage.slice(head);
      head = 0;
    }
  }

  function enqueue(key: K): void {
    // If currently processing, buffer as dirty instead of re-enqueuing
    if (processing.has(key)) {
      dirty.add(key);
      return;
    }
    // Skip if already in queue — O(1) via Set mirror
    if (queuedSet.has(key)) return;
    queueStorage.push(key);
    queuedSet.add(key);
  }

  function dequeue(): K | undefined {
    while (head < queueStorage.length) {
      const key = queueStorage[head];
      queueStorage[head] = undefined;
      head += 1;
      if (key === undefined) continue; // tombstone from remove()
      queuedSet.delete(key);
      processing.add(key);
      maybeCompact();
      return key;
    }
    // Queue exhausted — reset storage to reclaim memory
    if (head > 0) {
      queueStorage = [];
      head = 0;
    }
    return undefined;
  }

  function complete(key: K): void {
    processing.delete(key);
    // If re-enqueued during processing, move to queue tail
    if (dirty.has(key)) {
      dirty.delete(key);
      queueStorage.push(key);
      queuedSet.add(key);
    }
  }

  function remove(key: K): void {
    // Tombstone the entry in queueStorage rather than splice — O(1) instead of O(n).
    // dequeue() skips undefined tombstones; the queue self-compacts in maybeCompact().
    if (queuedSet.has(key)) {
      queuedSet.delete(key);
      // Scan from head to find and tombstone the entry. Single O(n) scan is
      // unavoidable here since we don't keep index-per-key, but remove() is
      // called on deregister — far less hot than enqueue/dequeue.
      for (let i = head; i < queueStorage.length; i++) {
        if (queueStorage[i] === key) {
          queueStorage[i] = undefined;
          break;
        }
      }
    }
    processing.delete(key);
    dirty.delete(key);
  }

  function size(): number {
    return queuedSet.size + processing.size;
  }

  function has(key: K): boolean {
    return queuedSet.has(key) || processing.has(key) || dirty.has(key);
  }

  function clear(): void {
    queueStorage = [];
    head = 0;
    queuedSet.clear();
    processing.clear();
    dirty.clear();
  }

  return { enqueue, dequeue, complete, remove, size, has, clear };
}
