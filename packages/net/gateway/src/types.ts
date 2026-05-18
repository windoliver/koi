/**
 * Gateway wire protocol types, session model, routing types, and config.
 *
 * Minimal v2 surface — no node registry, tool routing, scheduler, or channel binding.
 * All properties are readonly per L0/L2 immutability rules.
 */

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

export interface ConnectClient {
  readonly id?: string | undefined;
  readonly version?: string | undefined;
  readonly platform?: string | undefined;
}

export interface ConnectFrame {
  readonly kind: "connect";
  readonly minProtocol: number;
  readonly maxProtocol: number;
  readonly auth: {
    readonly token: string;
  };
  readonly client?: ConnectClient | undefined;
}

export type GatewayFrameKind = "request" | "response" | "event" | "ack" | "error";

export interface GatewayFrame {
  readonly kind: GatewayFrameKind;
  /** Unique message ID (dedup key). */
  readonly id: string;
  /** Monotonic sequence number. */
  readonly seq: number;
  /** Correlates a response to its originating request. */
  readonly ref?: string | undefined;
  readonly payload: unknown;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface RoutingContext {
  readonly channel?: string | undefined;
  readonly account?: string | undefined;
  readonly peer?: string | undefined;
}

export type ScopingMode = "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";

export interface RouteBinding {
  readonly pattern: string;
  readonly agentId: string;
}

export interface RoutingConfig {
  readonly scopingMode: ScopingMode;
  readonly bindings?: readonly RouteBinding[] | undefined;
}

// ---------------------------------------------------------------------------
// Session — re-export of the L0u canonical type so existing consumers of
// `@koi/gateway` keep working without an import path change.
// ---------------------------------------------------------------------------

export type { Session } from "@koi/gateway-types";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type AuthResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly agentId: string;
      readonly metadata: Readonly<Record<string, unknown>>;
      readonly routing?: RoutingContext | undefined;
    }
  | {
      readonly ok: false;
      readonly code: "INVALID_TOKEN" | "EXPIRED" | "FORBIDDEN";
      readonly message: string;
    };

// ---------------------------------------------------------------------------
// Handshake payloads
// ---------------------------------------------------------------------------

export interface GatewayCapabilities {
  readonly compression: boolean;
  readonly maxFrameBytes: number;
}

export interface HandshakeSnapshot {
  readonly serverTime: number;
  readonly activeConnections: number;
}

export interface HandshakeAckPayload {
  readonly sessionId: string;
  readonly protocol: number;
  readonly capabilities: GatewayCapabilities;
  readonly snapshot?: HandshakeSnapshot | undefined;
  /** Server's next expected incoming seq from the client; client resumes replaying from here. */
  readonly remoteSeq?: number | undefined;
}

// ---------------------------------------------------------------------------
// Backpressure
// ---------------------------------------------------------------------------

export type BackpressureState = "normal" | "warning" | "critical";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  readonly minProtocolVersion: number;
  readonly maxProtocolVersion: number;
  readonly capabilities: GatewayCapabilities;
  readonly includeSnapshot: boolean;
  readonly maxConnections: number;
  readonly backpressureHighWatermark: number;
  readonly maxBufferBytesPerConnection: number;
  readonly globalBufferLimitBytes: number;
  readonly dedupWindowSize: number;
  readonly authTimeoutMs: number;
  readonly backpressureCriticalTimeoutMs: number;
  /** How long (ms) to retain disconnected sessions before evicting from the store.
   *  0 or undefined = retain until destroySession() or stop(). */
  readonly disconnectedSessionTtlMs?: number | undefined;
  /** When true, stop() does NOT delete owned sessions from the store. Use when
   *  the store is shared/persistent (e.g. Nexus-backed) and sessions must survive
   *  a SIGTERM/restart so peers can reconnect. Default: false. */
  readonly preserveSessionsOnStop?: boolean | undefined;
  /** Time without node heartbeat before the gateway marks a node offline. */
  readonly nodeHeartbeatTimeoutMs: number;
  /** How often to sweep connected nodes for missed heartbeats. */
  readonly nodeSweepIntervalMs: number;
  // routing?: RoutingConfig — deferred: per-route handler isolation belongs to
  // the node registry layer, not the transport gateway. See intentional omissions.
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  minProtocolVersion: 1,
  maxProtocolVersion: 1,
  capabilities: { compression: false, maxFrameBytes: 1_048_576 },
  includeSnapshot: true,
  maxConnections: 10_000,
  backpressureHighWatermark: 0.8,
  maxBufferBytesPerConnection: 1_048_576,
  globalBufferLimitBytes: 500 * 1024 * 1024,
  dedupWindowSize: 128,
  authTimeoutMs: 5_000,
  backpressureCriticalTimeoutMs: 30_000,
  // Retain disconnected sessions for 5 minutes by default. Covers reconnect jitter
  // without accumulating stale replay-window state indefinitely. Set to 0 to disable
  // retention (delete on disconnect) or increase for longer grace periods.
  disconnectedSessionTtlMs: 300_000,
  nodeHeartbeatTimeoutMs: 30_000,
  nodeSweepIntervalMs: 5_000,
} as const;
