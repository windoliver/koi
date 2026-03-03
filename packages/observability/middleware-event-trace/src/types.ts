/**
 * Configuration and handle types for the event-trace middleware.
 */

import type {
  ChainId,
  EventCursor,
  KoiError,
  KoiMiddleware,
  Result,
  SnapshotChainStore,
  TraceEvent,
  TurnTrace,
} from "@koi/core";

/** Configuration for creating an event-trace middleware instance. */
export interface EventTraceConfig {
  /** Snapshot chain store for persisting turn traces. */
  readonly store: SnapshotChainStore<TurnTrace>;
  /** Chain ID used for storing traces in the snapshot chain. */
  readonly chainId: ChainId;
  /** Clock function for timestamps. Default: Date.now. */
  readonly clock?: () => number;
}

/** Handle returned from createEventTraceMiddleware for querying trace data. */
export interface EventTraceHandle {
  /** The middleware instance to register with the engine. */
  readonly middleware: KoiMiddleware;
  /** Retrieve the TurnTrace for a specific turn index. */
  readonly getTurnTrace: (turnIndex: number) => Promise<Result<TurnTrace | undefined, KoiError>>;
  /** Retrieve all trace events between two cursors (inclusive). */
  readonly getEventsBetween: (
    from: EventCursor,
    to: EventCursor,
  ) => Promise<Result<readonly TraceEvent[], KoiError>>;
  /** Return the next event index that would be assigned. */
  readonly currentEventIndex: () => number;
}
