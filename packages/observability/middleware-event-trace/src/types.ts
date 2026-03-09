/**
 * Configuration and handle types for the event-trace middleware.
 */

import type {
  ChainId,
  EventCursor,
  KoiError,
  KoiMiddleware,
  Result,
  SessionId,
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
  /** Retrieve the TurnTrace for a specific session and turn index. */
  readonly getTurnTrace: (
    sessionId: SessionId,
    turnIndex: number,
  ) => Promise<Result<TurnTrace | undefined, KoiError>>;
  /** Retrieve all trace events between two cursors (inclusive).
   *  When sessionId is provided, only events from that session are returned. */
  readonly getEventsBetween: (
    from: EventCursor,
    to: EventCursor,
    sessionId?: SessionId,
  ) => Promise<Result<readonly TraceEvent[], KoiError>>;
  /** Return the next event index that would be assigned for the given session. */
  readonly currentEventIndex: (sessionId: SessionId) => number;
}
