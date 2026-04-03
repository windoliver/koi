/**
 * Bounded write-behind buffer with FIFO eviction and incremental stats.
 */

import type { AggregatedStats, TrajectoryEntry } from "./types.js";

export interface TrajectoryBuffer {
  /** Append an entry to the buffer, evicting oldest if at capacity. Returns evicted count. */
  readonly record: (entry: TrajectoryEntry) => number;
  /** Return all buffered entries and clear the buffer. Stats are preserved until reset. */
  readonly flush: () => readonly TrajectoryEntry[];
  /** Return current aggregated stats per identifier. */
  readonly getStats: () => ReadonlyMap<string, AggregatedStats>;
  /** Reset stats (call after session end processing). */
  readonly resetStats: () => void;
  /** Current number of buffered entries. */
  readonly size: () => number;
  /** Maximum buffer capacity. */
  readonly capacity: () => number;
}

/** Creates a bounded trajectory buffer with FIFO eviction. */
export function createTrajectoryBuffer(maxEntries: number): TrajectoryBuffer {
  // let: mutable ring buffer for write-behind recording
  const entries: TrajectoryEntry[] = [];
  const stats = new Map<string, AggregatedStats>();

  function updateStats(entry: TrajectoryEntry): void {
    const existing = stats.get(entry.identifier);
    if (existing !== undefined) {
      const updated: AggregatedStats = {
        identifier: entry.identifier,
        kind: entry.kind,
        successes: existing.successes + (entry.outcome === "success" ? 1 : 0),
        failures: existing.failures + (entry.outcome === "failure" ? 1 : 0),
        retries: existing.retries + (entry.outcome === "retry" ? 1 : 0),
        totalDurationMs: existing.totalDurationMs + entry.durationMs,
        invocations: existing.invocations + 1,
        lastSeenMs: entry.timestamp,
      };
      stats.set(entry.identifier, updated);
    } else {
      const fresh: AggregatedStats = {
        identifier: entry.identifier,
        kind: entry.kind,
        successes: entry.outcome === "success" ? 1 : 0,
        failures: entry.outcome === "failure" ? 1 : 0,
        retries: entry.outcome === "retry" ? 1 : 0,
        totalDurationMs: entry.durationMs,
        invocations: 1,
        lastSeenMs: entry.timestamp,
      };
      stats.set(entry.identifier, fresh);
    }
  }

  return {
    record(entry: TrajectoryEntry): number {
      updateStats(entry);
      entries.push(entry);

      // FIFO eviction
      let evicted = 0; // let: counter for evicted entries
      while (entries.length > maxEntries) {
        entries.shift();
        evicted++;
      }
      return evicted;
    },

    flush(): readonly TrajectoryEntry[] {
      const snapshot = [...entries];
      entries.length = 0;
      return snapshot;
    },

    getStats(): ReadonlyMap<string, AggregatedStats> {
      return new Map(stats);
    },

    resetStats(): void {
      stats.clear();
    },

    size(): number {
      return entries.length;
    },

    capacity(): number {
      return maxEntries;
    },
  };
}
