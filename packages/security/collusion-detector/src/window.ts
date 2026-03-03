/**
 * Sliding observation window — bounded storage for agent observations.
 *
 * Evicts observations from old rounds when the window fills.
 */

import type { AgentObservation } from "./types.js";

// ---------------------------------------------------------------------------
// ObservationWindow
// ---------------------------------------------------------------------------

/** A sliding window of agent observations bounded by round count. */
export interface ObservationWindow {
  /** Record a new observation. Evicts old rounds if window is full. */
  readonly record: (observation: AgentObservation) => void;
  /** Return all observations in the window. */
  readonly observations: () => readonly AgentObservation[];
  /** Return observations for a specific round. */
  readonly observationsForRound: (round: number) => readonly AgentObservation[];
  /** Return the latest round number, or -1 if empty. */
  readonly latestRound: () => number;
  /** Clear all observations. */
  readonly clear: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a sliding observation window bounded by max round count. */
export function createObservationWindow(maxRounds: number): ObservationWindow {
  // let: reassigned on every mutation (encapsulated mutable state)
  let store: readonly AgentObservation[] = [];
  let roundSet = new Set<number>();

  function evictOldRounds(): void {
    if (roundSet.size <= maxRounds) return;

    const sortedRounds = [...roundSet].sort((a, b) => a - b);
    const evictCount = sortedRounds.length - maxRounds;
    const evictSet = new Set(sortedRounds.slice(0, evictCount));

    store = store.filter((o) => !evictSet.has(o.round));

    const nextRoundSet = new Set<number>();
    for (const r of roundSet) {
      if (!evictSet.has(r)) {
        nextRoundSet.add(r);
      }
    }
    roundSet = nextRoundSet;
  }

  return {
    record(observation: AgentObservation): void {
      store = [...store, observation];
      roundSet = new Set([...roundSet, observation.round]);
      evictOldRounds();
    },

    observations(): readonly AgentObservation[] {
      return [...store];
    },

    observationsForRound(round: number): readonly AgentObservation[] {
      return store.filter((o) => o.round === round);
    },

    latestRound(): number {
      if (roundSet.size === 0) return -1;
      return Math.max(...roundSet);
    },

    clear(): void {
      store = [];
      roundSet = new Set<number>();
    },
  };
}
