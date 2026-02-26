/**
 * Gateway-specific types. No runtime code.
 */

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Connect handshake (structured first message)
// ---------------------------------------------------------------------------

export interface ConnectClient {
  /** Client instance identifier. */
  readonly id?: string;
  /** Client version string (e.g. "1.2.0"). */
  readonly version?: string;
  /** Platform hint (e.g. "web", "ios", "cli", "node"). */
  readonly platform?: string;
}

/** Session resume request embedded in a ConnectFrame. */
export interface ResumeRequest {
  readonly sessionId: string;
  readonly lastSeq: number;
}

export interface ConnectFrame {
  readonly kind: "connect";
  /** Minimum protocol version the client supports (positive integer). */
  readonly minProtocol: number;
  /** Maximum protocol version the client supports (positive integer, >= minProtocol). */
  readonly maxProtocol: number;
  readonly auth: {
    readonly token: string;
  };
  readonly client?: ConnectClient;
  /** If present, the client is attempting to resume a previous session. */
  readonly resume?: ResumeRequest;
}

// ---------------------------------------------------------------------------
// Wire protocol frames (post-handshake)
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
// Routing
// ---------------------------------------------------------------------------

export interface RoutingContext {
  readonly channel?: string;
  readonly account?: string;
  readonly peer?: string;
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
  readonly routing?: RoutingContext;
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
      readonly routing?: RoutingContext;
    }
  | {
      readonly ok: false;
      readonly code: "INVALID_TOKEN" | "EXPIRED" | "FORBIDDEN";
      readonly message: string;
    };

// ---------------------------------------------------------------------------
// Handshake payload types
// ---------------------------------------------------------------------------

export interface GatewayCapabilities {
  /** Whether the server supports per-message compression. */
  readonly compression: boolean;
  /** Whether the server supports session resumption after disconnect. */
  readonly resumption: boolean;
  /** Maximum frame payload size in bytes the server will accept. */
  readonly maxFrameBytes: number;
}

export interface HandshakeSnapshot {
  /** Server's current timestamp (ms). Enables client clock-skew detection. */
  readonly serverTime: number;
  /** Current number of active connections. Coarse load signal. */
  readonly activeConnections: number;
}

export interface HandshakeAckPayload {
  readonly sessionId: string;
  /** Negotiated protocol version (highest mutually supported). */
  readonly protocol: number;
  readonly capabilities: GatewayCapabilities;
  readonly snapshot?: HandshakeSnapshot;
}

// ---------------------------------------------------------------------------
// Scoping + route bindings
// ---------------------------------------------------------------------------

export type ScopingMode = "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";

export interface RouteBinding {
  readonly pattern: string;
  readonly agentId: string;
}

export interface RoutingConfig {
  readonly scopingMode: ScopingMode;
  readonly bindings?: readonly RouteBinding[];
}

export interface SchedulerDef {
  readonly id: string;
  readonly intervalMs: number;
  readonly agentId: string;
  readonly payload?: unknown;
}

/** Static channel-to-agent binding for routing. */
export interface ChannelBinding {
  readonly channelName: string;
  readonly agentId: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  /** Minimum protocol version the server supports. Default: 1. */
  readonly minProtocolVersion: number;
  /** Maximum protocol version the server supports. Default: 1. */
  readonly maxProtocolVersion: number;
  /** Capabilities advertised to clients during handshake. */
  readonly capabilities: GatewayCapabilities;
  /** Whether to include a runtime snapshot in the handshake ack. Default: true. */
  readonly includeSnapshot: boolean;
  /** Maximum concurrent connections. Default: 10_000. */
  readonly maxConnections: number;
  /** Buffer utilization ratio that triggers warning state. Default: 0.8. */
  readonly backpressureHighWatermark: number;
  /** Maximum buffered bytes per connection. Default: 1_048_576 (1MB). */
  readonly maxBufferBytesPerConnection: number;
  /** Global buffer limit in bytes across all connections. Default: 500MB. */
  readonly globalBufferLimitBytes: number;
  /** Sliding window size for dedup. Default: 128. */
  readonly dedupWindowSize: number;
  /** Heartbeat interval in ms. Default: 30_000. */
  readonly heartbeatIntervalMs: number;
  /** Auth handshake timeout in ms. Default: 5_000. */
  readonly authTimeoutMs: number;
  /** Time in ms before a connection in critical backpressure is force-closed. Default: 30_000. */
  readonly backpressureCriticalTimeoutMs: number;
  /** Timer sweep interval in ms. Default: 10_000. */
  readonly sweepIntervalMs: number;
  /** Optional routing configuration for session dispatch. */
  readonly routing?: RoutingConfig;
  /** Port for webhook HTTP server. Undefined = disabled. */
  readonly webhookPort?: number;
  /** URL path prefix for webhook endpoints. Default: "/webhook". */
  readonly webhookPath?: string;
  /** Scheduler definitions for periodic frame dispatch. */
  readonly schedulers?: readonly SchedulerDef[];
  /** Node heartbeat timeout in ms. Nodes not heartbeating within this window are evicted. Default: 90_000 (3x heartbeat interval). */
  readonly nodeHeartbeatTimeoutMs: number;
  /** Session time-to-live after disconnect (ms). 0 = immediate cleanup. Default: 0. */
  readonly sessionTtlMs: number;
  /** Static channel-to-agent bindings, loaded at startup. */
  readonly channelBindings?: readonly ChannelBinding[];
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  minProtocolVersion: 1,
  maxProtocolVersion: 1,
  capabilities: { compression: false, resumption: false, maxFrameBytes: 1_048_576 },
  includeSnapshot: true,
  maxConnections: 10_000,
  backpressureHighWatermark: 0.8,
  maxBufferBytesPerConnection: 1_048_576,
  globalBufferLimitBytes: 500 * 1024 * 1024,
  dedupWindowSize: 128,
  heartbeatIntervalMs: 30_000,
  authTimeoutMs: 5_000,
  backpressureCriticalTimeoutMs: 30_000,
  sweepIntervalMs: 10_000,
  nodeHeartbeatTimeoutMs: 90_000,
  sessionTtlMs: 0,
} as const;

// ---------------------------------------------------------------------------
// Backpressure
// ---------------------------------------------------------------------------

export type BackpressureState = "normal" | "warning" | "critical";
