/**
 * Frame deduplicator — bounded Set + FIFO ring buffer for inbound frame dedup.
 *
 * Tracks frame IDs (correlationIds) to detect and drop duplicate inbound
 * frames caused by Gateway retransmits on reconnect.
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface FrameDeduplicator {
  /** Returns true if this ID was already seen (duplicate). */
  readonly isDuplicate: (id: string) => boolean;
  /** Clear all tracked state. */
  readonly reset: () => void;
  /** Number of currently tracked IDs. */
  readonly size: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Matches transport queue limit; ~1 hour of reconnects at 3Hz worst case. */
const DEFAULT_MAX_SIZE = 10_000;

export function createFrameDeduplicator(maxSize: number = DEFAULT_MAX_SIZE): FrameDeduplicator {
  const seen = new Set<string>();
  const ring: string[] = [];
  let head = 0;

  function isDuplicate(id: string): boolean {
    if (seen.has(id)) return true;

    // Evict oldest when at capacity
    if (seen.size >= maxSize) {
      const evict = ring[head];
      if (evict !== undefined) {
        seen.delete(evict);
      }
      ring[head] = id;
      head = (head + 1) % maxSize;
    } else {
      ring.push(id);
    }

    seen.add(id);
    return false;
  }

  function reset(): void {
    seen.clear();
    ring.length = 0;
    head = 0;
  }

  function size(): number {
    return seen.size;
  }

  return { isDuplicate, reset, size };
}
