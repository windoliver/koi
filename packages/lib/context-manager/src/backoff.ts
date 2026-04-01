/**
 * Exponential backoff tracker for compaction failures.
 *
 * Pure state management — no timers, no side effects.
 * Uses turn numbers for deterministic behavior.
 */

import type { CompactionState } from "./types.js";
import { COMPACTION_DEFAULTS } from "./types.js";

export interface BackoffTracker {
  /** Check if compaction should be skipped this turn due to backoff. */
  readonly shouldSkip: (state: CompactionState) => boolean;
  /** Record a compaction failure, returning updated state with new backoff. */
  readonly recordFailure: (state: CompactionState) => CompactionState;
  /** Record a compaction success, returning state with reset counters. */
  readonly recordSuccess: (state: CompactionState) => CompactionState;
}

/**
 * Create a backoff tracker with configurable initial skip and cap.
 *
 * After each consecutive failure, the skip duration doubles:
 *   initialSkip * 2^(consecutiveFailures - 1)
 * capped at `cap` turns.
 */
export function createBackoffTracker(
  initialSkip: number = COMPACTION_DEFAULTS.backoff.initialSkip,
  cap: number = COMPACTION_DEFAULTS.backoff.cap,
): BackoffTracker {
  return {
    shouldSkip(state: CompactionState): boolean {
      // skipUntilTurn is inclusive — skip ON that turn, retry after it
      return state.currentTurn <= state.skipUntilTurn && state.skipUntilTurn > 0;
    },

    recordFailure(state: CompactionState): CompactionState {
      const failures = state.consecutiveFailures + 1;
      // Exponential: initialSkip * 2^(failures-1), capped
      const rawSkip = initialSkip * 2 ** (failures - 1);
      const skip = Math.min(rawSkip, cap);
      return {
        ...state,
        consecutiveFailures: failures,
        skipUntilTurn: state.currentTurn + skip,
      };
    },

    recordSuccess(state: CompactionState): CompactionState {
      return {
        ...state,
        consecutiveFailures: 0,
        skipUntilTurn: 0,
      };
    },
  };
}
