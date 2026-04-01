/**
 * SharedLog — per-invocation shared transcript for batched sub-calls.
 *
 * Allows sub-calls within a single rlm_process invocation to share
 * findings, avoiding redundant work when processing the same input.
 *
 * Entries are capped to prevent unbounded context growth. Oldest
 * entries are dropped when the cap is exceeded.
 */

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_SHARED_LOG_ENTRIES: number = 20;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface SharedLog {
  /** Append a finding summary. Drops oldest entry if cap exceeded. */
  readonly append: (summary: string) => void;
  /** Return all current entries (oldest first). */
  readonly entries: () => readonly string[];
  /** Clear all entries (used on compaction). */
  readonly clear: () => void;
  /** Current number of entries. */
  readonly size: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SharedLog with a configurable entry cap.
 *
 * @param maxEntries Maximum entries to retain. Default: 20.
 */
export function createSharedLog(maxEntries: number = DEFAULT_MAX_SHARED_LOG_ENTRIES): SharedLog {
  // let: mutable array, encapsulated within closure
  let entries: string[] = [];

  return {
    append(summary: string): void {
      entries.push(summary);
      if (entries.length > maxEntries) {
        entries = entries.slice(entries.length - maxEntries);
      }
    },

    entries(): readonly string[] {
      return entries;
    },

    clear(): void {
      entries = [];
    },

    size(): number {
      return entries.length;
    },
  };
}
