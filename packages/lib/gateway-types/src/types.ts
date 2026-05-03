/**
 * Gateway wire-protocol and session types shared across L2 gateway packages.
 *
 * Extracted from the gateway package so L2 peers can import without
 * violating the L2-isolation constraint. All properties are readonly.
 */

// ---------------------------------------------------------------------------
// Wire frames
// ---------------------------------------------------------------------------

export type GatewayFrameKind = "request" | "response" | "event" | "ack" | "error";

export interface GatewayFrame {
  readonly kind: GatewayFrameKind;
  /** Unique message ID — used as dedup key. */
  readonly id: string;
  /** Monotonic sequence number. */
  readonly seq: number;
  /** Correlates a response to its originating request. */
  readonly ref?: string | undefined;
  readonly payload: unknown;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Routing context
// ---------------------------------------------------------------------------

export interface RoutingContext {
  readonly channel?: string | undefined;
  readonly account?: string | undefined;
  readonly peer?: string | undefined;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface Session {
  readonly id: string;
  readonly agentId: string;
  readonly connectedAt: number;
  readonly lastHeartbeat: number;
  readonly seq: number;
  readonly remoteSeq: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly routing?: RoutingContext | undefined;
  /** Ms-since-epoch when the session was last disconnected. Persisted so TTL
   *  eviction survives process restarts; the reconnect path rejects sessions
   *  whose `disconnectedAt` is past TTL. */
  readonly disconnectedAt?: number | undefined;
}

// ---------------------------------------------------------------------------
// Session store contract
// ---------------------------------------------------------------------------

import type { KoiError, Result } from "@koi/core";

/**
 * Pluggable session persistence shared across L2 gateway packages.
 *
 * Read/write operations may be sync (in-memory) or async (Nexus/HA backend) —
 * callers must always `await` the result. Sync `entries()` and `size()` are
 * intentionally local-only because the gateway's heartbeat sweep iterates
 * them on a hot path; async-only iteration would require materializing every
 * remote session per tick.
 */
export interface SessionStore {
  readonly get: (id: string) => Result<Session, KoiError> | Promise<Result<Session, KoiError>>;
  readonly set: (session: Session) => Result<void, KoiError> | Promise<Result<void, KoiError>>;
  readonly delete: (id: string) => Result<boolean, KoiError> | Promise<Result<boolean, KoiError>>;
  readonly has: (id: string) => Result<boolean, KoiError> | Promise<Result<boolean, KoiError>>;
  readonly size: () => number;
  readonly entries: () => IterableIterator<readonly [string, Session]>;
}

// ---------------------------------------------------------------------------
// Gateway ingestor contract
// ---------------------------------------------------------------------------

/**
 * Runtime ingestor contract for gateway implementations.
 * `@koi/gateway` (L2) implements this; `@koi/gateway-http` (L2) consumes it
 * via dependency injection so neither package depends on the other.
 */
export interface Gateway {
  /** Ingest a frame produced by the HTTP ingestion path (or any caller). */
  readonly ingest: (session: Session, frame: GatewayFrame) => void | Promise<void>;
  /** Stop accepting NEW frames from external transports (e.g., WS clients); existing internal `ingest()` callers continue. */
  readonly pauseIngress: () => void | Promise<void>;
  /** Force-close all transport-attached sessions (e.g., WS connections) immediately. */
  readonly forceClose: () => void | Promise<void>;
  /** Number of active transport-attached connections (e.g., WS sessions). HTTP ingestion does not count toward this. */
  readonly activeConnections: () => number | Promise<number>;
}
