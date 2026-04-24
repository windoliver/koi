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
}
