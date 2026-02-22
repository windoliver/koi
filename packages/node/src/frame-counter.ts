/**
 * Per-agent outbound/inbound frame sequence counters.
 *
 * Used to populate `seq` and `remoteSeq` in session records so that
 * crash recovery can resume from the correct position.
 */

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface FrameCounterState {
  readonly seq: number;
  readonly remoteSeq: number;
}

export interface FrameCounters {
  /** Increment outbound sequence for an agent. Returns the new seq. */
  readonly increment: (agentId: string) => number;
  /** Update the latest known remote (inbound) sequence for an agent. */
  readonly updateRemote: (agentId: string, remoteSeq: number) => void;
  /** Get current counters for an agent. Returns 0/0 for unknown agents. */
  readonly get: (agentId: string) => FrameCounterState;
  /** Remove counters for an agent. */
  readonly remove: (agentId: string) => void;
  /** Restore counters from a recovered session record. */
  readonly restore: (agentId: string, seq: number, remoteSeq: number) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface MutableCounters {
  seq: number;
  remoteSeq: number;
}

const ZERO_STATE: FrameCounterState = { seq: 0, remoteSeq: 0 };

export function createFrameCounters(): FrameCounters {
  const counters = new Map<string, MutableCounters>();

  function getOrCreate(agentId: string): MutableCounters {
    let entry = counters.get(agentId);
    if (entry === undefined) {
      entry = { seq: 0, remoteSeq: 0 };
      counters.set(agentId, entry);
    }
    return entry;
  }

  return {
    increment(agentId: string): number {
      const entry = getOrCreate(agentId);
      entry.seq += 1;
      return entry.seq;
    },

    updateRemote(agentId: string, remoteSeq: number): void {
      const entry = getOrCreate(agentId);
      entry.remoteSeq = remoteSeq;
    },

    get(agentId: string): FrameCounterState {
      const entry = counters.get(agentId);
      if (entry === undefined) return ZERO_STATE;
      return { seq: entry.seq, remoteSeq: entry.remoteSeq };
    },

    remove(agentId: string): void {
      counters.delete(agentId);
    },

    restore(agentId: string, seq: number, remoteSeq: number): void {
      counters.set(agentId, { seq, remoteSeq });
    },
  };
}
