/**
 * Gateway-specific types. No runtime code.
 */

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

export type GatewayFrameKind = "request" | "response" | "event" | "ack" | "error";

export interface GatewayFrame {
  readonly kind: GatewayFrameKind;
  /** Unique message ID (dedup key). */
  readonly id: string;
  /** Monotonic sequence number. */
  readonly seq: number;
  /** Correlates a response to its originating request. */
  readonly ref?: string;
  readonly payload: unknown;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface Session {
  readonly id: string;
  readonly agentId: string;
  readonly connectedAt: number;
  readonly lastHeartbeat: number;
  /** Local outbound sequence counter. */
  readonly seq: number;
  /** Last accepted inbound sequence from remote. */
  readonly remoteSeq: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type AuthResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly agentId: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    }
  | {
      readonly ok: false;
      readonly code: "INVALID_TOKEN" | "EXPIRED" | "FORBIDDEN";
      readonly message: string;
    };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  /** Maximum concurrent connections. Default: 10_000. */
  readonly maxConnections: number;
  /** Buffer utilization ratio that triggers warning state. Default: 0.8. */
  readonly backpressureHighWatermark: number;
  /** Maximum buffered frames per connection. Default: 256. */
  readonly maxBufferPerConnection: number;
  /** Global buffer limit in bytes across all connections. Default: 500MB. */
  readonly globalBufferLimitBytes: number;
  /** Sliding window size for dedup. Default: 128. */
  readonly dedupWindowSize: number;
  /** Heartbeat interval in ms. Default: 30_000. */
  readonly heartbeatIntervalMs: number;
  /** Auth handshake timeout in ms. Default: 5_000. */
  readonly authTimeoutMs: number;
  /** Timer sweep interval in ms. Default: 10_000. */
  readonly sweepIntervalMs: number;
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  maxConnections: 10_000,
  backpressureHighWatermark: 0.8,
  maxBufferPerConnection: 256,
  globalBufferLimitBytes: 500 * 1024 * 1024,
  dedupWindowSize: 128,
  heartbeatIntervalMs: 30_000,
  authTimeoutMs: 5_000,
  sweepIntervalMs: 10_000,
} as const;

// ---------------------------------------------------------------------------
// Backpressure
// ---------------------------------------------------------------------------

export type BackpressureState = "normal" | "warning" | "critical";
