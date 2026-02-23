/**
 * Per-turn mutable collector with monotonic counter.
 *
 * Internal state — NOT exposed in the public API.
 * The counter is global across turns (never resets between turns)
 * so event indices are unique within a session.
 */

import type { TraceEvent, TraceEventKind } from "@koi/core";

/** Internal collector interface for recording trace events. */
export interface TraceCollector {
  /** Record an event and return the created TraceEvent. */
  readonly record: (turnIndex: number, event: TraceEventKind) => TraceEvent;
  /** Return a copy of all events recorded in the current turn. */
  readonly getEvents: () => readonly TraceEvent[];
  /** Return the next event index that would be assigned. */
  readonly currentIndex: () => number;
  /** Clear events for the current turn (preserves global counter). */
  readonly reset: () => void;
}

/**
 * Creates a trace collector that assigns monotonic event indices.
 * The counter is global across turns (never resets between turns)
 * so event indices are unique within a session.
 */
export function createTraceCollector(clock?: () => number): TraceCollector {
  const getClock = clock ?? Date.now;
  // Mutable internal state — intentional for performance
  let nextIndex = 0;
  let events: TraceEvent[] = [];

  const record = (turnIndex: number, event: TraceEventKind): TraceEvent => {
    const traceEvent: TraceEvent = {
      eventIndex: nextIndex,
      turnIndex,
      event,
      timestamp: getClock(),
    };
    nextIndex += 1;
    events = [...events, traceEvent];
    return traceEvent;
  };

  const getEvents = (): readonly TraceEvent[] => [...events];

  const currentIndex = (): number => nextIndex;

  const reset = (): void => {
    events = [];
  };

  return { record, getEvents, currentIndex, reset };
}
