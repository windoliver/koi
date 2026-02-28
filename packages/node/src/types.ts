/**
 * @koi/node — Configuration schema (Zod) and domain types.
 *
 * NodeConfig is the sole configuration surface for createNode().
 * All sub-configs have sane defaults; only `gateway.url` is required.
 *
 * Schemas are module-private. Only types and parseNodeConfig() are exported,
 * keeping the public API compatible with isolatedDeclarations.
 */

import type {
  AdvertisedTool,
  CapacityReport,
  KoiError,
  PendingFrame,
  RecoveryPlan,
  Result,
  SessionCheckpoint,
  SessionPersistence,
  SessionRecord,
} from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

export type {
  AdvertisedTool,
  CapacityReport,
  ToolCallPayload,
  ToolErrorPayload,
  ToolResultPayload,
} from "@koi/core";

import { z } from "zod";

// ---------------------------------------------------------------------------
// Config schemas (not exported — isolatedDeclarations compliance)
// ---------------------------------------------------------------------------

const gatewayConnectionSchema = z.object({
  url: z.url(),
  reconnectBaseDelay: z.number().positive().default(1_000),
  reconnectMaxDelay: z.number().positive().default(30_000),
  reconnectMultiplier: z.number().positive().default(2),
  reconnectJitter: z.number().min(0).max(1).default(0.1),
  maxRetries: z.number().int().nonnegative().default(10),
});

const heartbeatSchema = z.object({
  interval: z.number().positive().default(30_000),
  timeout: z.number().positive().default(5_000),
});

const discoverySchema = z.object({
  enabled: z.boolean().default(true),
  serviceType: z.string().default("_koi-agent._tcp"),
});

const toolsSchema = z.object({
  directories: z.array(z.string()).default([]),
  builtins: z
    .object({
      filesystem: z.boolean().default(true),
      shell: z.boolean().default(true),
    })
    .default({ filesystem: true, shell: true }),
  toolCallTimeoutMs: z.number().positive().default(30_000),
});

const resourcesSchema = z.object({
  maxAgents: z.number().int().positive().default(50),
  memoryWarningPercent: z.number().min(0).max(100).default(80),
  memoryEvictionPercent: z.number().min(0).max(100).default(90),
  monitorInterval: z.number().positive().default(30_000),
});

const authSchema = z.object({
  /** Bearer token sent during initial auth handshake. */
  token: z.string().min(1),
  /** HMAC-SHA256 secret for challenge/response. Omit for token-only auth. */
  secret: z.string().min(1).optional(),
  /** Milliseconds to wait for auth to complete before giving up. */
  timeoutMs: z.number().positive().default(10_000),
});

const nodeConfigSchema = z.object({
  nodeId: z.string().optional(),
  /** Node mode: "full" runs engines + exposes tools; "thin" exposes tools only (no engine). */
  mode: z.enum(["full", "thin"]).default("full"),
  gateway: gatewayConnectionSchema,
  heartbeat: heartbeatSchema.default({ interval: 30_000, timeout: 5_000 }),
  discovery: discoverySchema.default({ enabled: true, serviceType: "_koi-agent._tcp" }),
  tools: toolsSchema.default({
    directories: [],
    builtins: { filesystem: true, shell: true },
    toolCallTimeoutMs: 30_000,
  }),
  resources: resourcesSchema.default({
    maxAgents: 50,
    memoryWarningPercent: 80,
    memoryEvictionPercent: 90,
    monitorInterval: 30_000,
  }),
  /** Optional auth config. Omit for unauthenticated connections. */
  auth: authSchema.optional(),
});

// ---------------------------------------------------------------------------
// Explicit config types (isolatedDeclarations-safe)
// ---------------------------------------------------------------------------

export interface GatewayConnectionConfig {
  readonly url: string;
  readonly reconnectBaseDelay: number;
  readonly reconnectMaxDelay: number;
  readonly reconnectMultiplier: number;
  readonly reconnectJitter: number;
  readonly maxRetries: number;
}

export interface HeartbeatConfig {
  readonly interval: number;
  readonly timeout: number;
}

export interface DiscoveryConfig {
  readonly enabled: boolean;
  readonly serviceType: string;
}

export interface ToolResolverConfig {
  readonly directories: readonly string[];
  readonly builtins: {
    readonly filesystem: boolean;
    readonly shell: boolean;
  };
  readonly toolCallTimeoutMs: number;
}

export interface ResourcesConfig {
  readonly maxAgents: number;
  readonly memoryWarningPercent: number;
  readonly memoryEvictionPercent: number;
  readonly monitorInterval: number;
}

export interface AuthConfig {
  /** Bearer token sent during initial auth handshake. */
  readonly token: string;
  /** HMAC-SHA256 secret for challenge/response. Omit for token-only auth. */
  readonly secret?: string | undefined;
  /** Milliseconds to wait for auth to complete (default 10 000). */
  readonly timeoutMs: number;
}

/** Node mode: "full" runs engines + exposes tools; "thin" exposes tools only (no engine). */
export type NodeMode = "full" | "thin";

export interface NodeConfig {
  readonly nodeId?: string | undefined;
  /** Node mode. Default: "full". Thin nodes skip engine/agent host, only handle tool_call frames. */
  readonly mode: NodeMode;
  readonly gateway: GatewayConnectionConfig;
  readonly heartbeat: HeartbeatConfig;
  readonly discovery: DiscoveryConfig;
  readonly tools: ToolResolverConfig;
  readonly resources: ResourcesConfig;
  /** Optional auth config. Omit for unauthenticated connections. */
  readonly auth?: AuthConfig | undefined;
}

// ---------------------------------------------------------------------------
// Config parser
// ---------------------------------------------------------------------------

/** Parse and validate raw config into a typed NodeConfig. */
export function parseNodeConfig(raw: unknown): Result<NodeConfig, KoiError> {
  const result = nodeConfigSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid node config: ${result.error.message}`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  // Zod output matches NodeConfig structurally; satisfies verifies at compile time
  const config: NodeConfig = result.data;
  return { ok: true, value: config };
}

// ---------------------------------------------------------------------------
// Node frame protocol types (Nexus-inspired envelope)
// ---------------------------------------------------------------------------

/** Discriminated union of all frame kinds flowing over the Node <-> Gateway WS. */
export type NodeFrameKind =
  | "agent:dispatch"
  | "agent:message"
  | "agent:status"
  | "agent:terminate"
  | "node:auth"
  | "node:auth_challenge"
  | "node:auth_response"
  | "node:auth_ack"
  | "node:handshake"
  | "node:heartbeat"
  | "node:capacity"
  | "node:capabilities"
  | "node:error"
  | "tool_call"
  | "tool_result"
  | "tool_error";

/** Wire frame sent over the multiplexed WebSocket. */
export interface NodeFrame {
  readonly nodeId: string;
  readonly agentId: string;
  readonly correlationId: string;
  /** Milliseconds until the frame expires. Undefined = no expiry. */
  readonly ttl?: number | undefined;
  readonly kind: NodeFrameKind;
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// Auth payloads
// ---------------------------------------------------------------------------

/** Node → Gateway: initial authentication. */
export interface AuthPayload {
  readonly token: string;
  readonly timestamp: number;
}

/** Gateway → Node: challenge for HMAC verification. */
export interface AuthChallengePayload {
  readonly challenge: string;
}

/** Node → Gateway: signed response to challenge. */
export interface AuthResponsePayload {
  readonly response: string;
}

/** Gateway → Node: auth result. */
export interface AuthAckPayload {
  readonly success: boolean;
  readonly reason?: string | undefined;
}

// ---------------------------------------------------------------------------
// Capability advertisement payloads
// ---------------------------------------------------------------------------

/** Node → Gateway: advertise this Node's tool surface. */
export interface CapabilitiesPayload {
  readonly nodeType: "full" | "thin";
  readonly tools: readonly AdvertisedTool[];
}

// ---------------------------------------------------------------------------
// Handshake payloads
// ---------------------------------------------------------------------------

export interface HandshakePayload {
  readonly nodeId: string;
  readonly version: string;
  readonly capacity: CapacityReport;
}

// ---------------------------------------------------------------------------
// Agent status payloads (Nexus-inspired spec/status reporting)
// ---------------------------------------------------------------------------

export interface AgentStatusPayload {
  readonly agentId: string;
  readonly state: string;
  readonly turnCount: number;
  readonly lastActivityMs: number;
}

// ---------------------------------------------------------------------------
// Node lifecycle
// ---------------------------------------------------------------------------

export type NodeState = "starting" | "connected" | "reconnecting" | "stopping" | "stopped";

// ---------------------------------------------------------------------------
// Node event types (emitted by internal subsystems)
// ---------------------------------------------------------------------------

export type NodeEventType =
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "reconnected"
  | "reconnect_exhausted"
  | "heartbeat_timeout"
  | "auth_started"
  | "auth_success"
  | "auth_failed"
  | "agent_dispatched"
  | "agent_terminated"
  | "agent_crashed"
  | "agent_recovered"
  | "tool_timeout"
  | "tool_error"
  | "memory_warning"
  | "memory_eviction"
  | "shutdown_started"
  | "shutdown_complete"
  | "pending_frame_sent"
  | "pending_frame_expired"
  | "pending_frame_dead_letter";

export interface NodeEvent {
  readonly type: NodeEventType;
  readonly timestamp: number;
  readonly data?: unknown;
}

/** Listener for node events. */
export type NodeEventListener = (event: NodeEvent) => void;

// ---------------------------------------------------------------------------
// Session persistence types — aliases to L0 (@koi/core) contracts.
// Previously duplicated here; now single source of truth in L0.
// ---------------------------------------------------------------------------

/** @deprecated Use `SessionRecord` from `@koi/core` directly. */
export type NodeSessionRecord = SessionRecord;

/** @deprecated Use `SessionCheckpoint` from `@koi/core` directly. */
export type NodeCheckpoint = SessionCheckpoint;

/** @deprecated Use `PendingFrame` from `@koi/core` directly. */
export type NodePendingFrame = PendingFrame;

/** @deprecated Use `RecoveryPlan` from `@koi/core` directly. */
export type NodeRecoveryPlan = RecoveryPlan;

/**
 * Session persistence interface accepted by the node for crash recovery.
 *
 * Subset of `SessionPersistence` from `@koi/core` — only the methods
 * the node actually uses. Any `SessionPersistence` implementation
 * (sqlite, in-memory) is structurally assignable to this type.
 */
export type NodeSessionStore = Pick<
  SessionPersistence,
  | "saveSession"
  | "removeSession"
  | "saveCheckpoint"
  | "loadLatestCheckpoint"
  | "savePendingFrame"
  | "loadPendingFrames"
  | "clearPendingFrames"
  | "removePendingFrame"
  | "recover"
  | "close"
>;
