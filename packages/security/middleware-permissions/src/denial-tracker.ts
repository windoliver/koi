/**
 * Per-session denial accumulator for observability and diagnostics.
 *
 * Records every denied tool call within a session. Queryable for
 * UI overlays, debug views, and audit analysis. Cleared on session end.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Why a denial was recorded — only "policy" denials count toward escalation. */
export type DenialSource = "policy" | "backend-error" | "approval" | "escalation";

export interface DenialRecord {
  readonly toolId: string;
  readonly reason: string;
  readonly timestamp: number;
  readonly principal: string;
  readonly turnIndex: number;
  /** Origin of the denial. Only "policy" denials trigger escalation. */
  readonly source: DenialSource;
}

export interface DenialTracker {
  /** Record a denied tool call. */
  readonly record: (denial: DenialRecord) => void;
  /** Get all denial records (oldest first). */
  readonly getAll: () => readonly DenialRecord[];
  /** Get denial records for a specific tool. */
  readonly getByTool: (toolId: string) => readonly DenialRecord[];
  /** Total number of recorded denials. */
  readonly count: () => number;
  /** Clear all records (called on session end). */
  readonly clear: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ENTRIES = 1024;

export function createDenialTracker(maxEntries: number = DEFAULT_MAX_ENTRIES): DenialTracker {
  const records: DenialRecord[] = [];

  return {
    record(denial) {
      if (records.length >= maxEntries) {
        records.shift();
      }
      records.push(denial);
    },

    getAll() {
      return [...records];
    },

    getByTool(toolId) {
      return records.filter((r) => r.toolId === toolId);
    },

    count() {
      return records.length;
    },

    clear() {
      records.length = 0;
    },
  };
}
