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
  /** Cache key scoping the query context. Used to scope escalation per-context. */
  readonly queryKey?: string | undefined;
  /**
   * #1650: soft vs hard disposition of this recorded deny. Present on
   * post-#1650 records. Absent for pre-#1650 records still in memory — callers
   * treat absence as `"hard"` (backward compat).
   */
  readonly softness?: "soft" | "hard" | undefined;
  /**
   * #1650: origin of the record. `"native"` for normal denies produced by the
   * rule evaluator, user approval deny, fail-closed, or pre-existing
   * escalation. `"soft-conversion"` for records produced when the per-turn
   * soft-deny cap or unkeyable fail-closed path promotes a soft candidate to
   * hard. Mechanism A's escalation prefilter excludes `"soft-conversion"`
   * records so per-turn cap events do NOT feed session-wide escalation.
   */
  readonly origin?: "native" | "soft-conversion" | undefined;
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
