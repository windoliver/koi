/**
 * Isolated append log for soft-deny events (#1650).
 *
 * Soft denies do NOT enter `DenialTracker` (which backs Mechanism A's
 * session-wide escalation prefilter and has a shared 1024-entry FIFO
 * budget). Keeping them in a separate log prevents high-volume recoverable
 * probes from evicting native hard-deny history that Mechanism A depends on.
 *
 * NOT exported from `index.ts` — internal to the package.
 */

export interface SoftDenyEntry {
  readonly toolId: string;
  readonly reason: string;
  readonly timestamp: number;
  readonly principal: string;
  readonly turnIndex: number;
  readonly queryKey?: string | undefined;
}

export interface SoftDenyLog {
  readonly record: (entry: SoftDenyEntry) => void;
  readonly getAll: () => readonly SoftDenyEntry[];
  readonly getByTool: (toolId: string) => readonly SoftDenyEntry[];
  readonly clear: () => void;
}

const DEFAULT_MAX_ENTRIES = 1024;

export function createSoftDenyLog(maxEntries: number = DEFAULT_MAX_ENTRIES): SoftDenyLog {
  const records: SoftDenyEntry[] = [];

  return {
    record(entry) {
      if (records.length >= maxEntries) records.shift();
      records.push(entry);
    },
    getAll() {
      return [...records];
    },
    getByTool(toolId) {
      return records.filter((r) => r.toolId === toolId);
    },
    clear() {
      records.length = 0;
    },
  };
}
