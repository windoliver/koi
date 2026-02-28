/**
 * @koi/node — Local device agent runtime (Layer 2).
 *
 * Hosts N agent entities on a local machine. Connects to the Koi Gateway
 * via a single multiplexed WebSocket. Provides local tool resolution,
 * mDNS discovery, memory monitoring, and graceful shutdown.
 */

export type { AgentHost } from "./agent/host.js";
// -- Agent host -------------------------------------------------------------
export { createAgentHost } from "./agent/host.js";
export type { StatusReporter } from "./agent/status.js";
export { createStatusReporter } from "./agent/status.js";
export type { AgentInbox, AgentMessagePayload, QueuedAgentMessage } from "./agent-inbox.js";
// -- Agent inbox ------------------------------------------------------------
export { createAgentInbox, isAgentMessagePayload, MAX_INBOX_DEPTH } from "./agent-inbox.js";
export type { CheckpointManager, CheckpointManagerDeps } from "./checkpoint.js";
// -- Checkpoint manager -----------------------------------------------------
export { createCheckpointManager } from "./checkpoint.js";
export type { CheckpointingEngineConfig } from "./checkpointing-engine.js";
// -- Auto-checkpointing engine decorator ------------------------------------
export { createCheckpointingEngine } from "./checkpointing-engine.js";
export type { AuthHandshake, AuthHandshakeConfig } from "./connection/auth.js";
export { createAuthHandshake, createAuthPayload, signChallenge } from "./connection/auth.js";
export type { HeartbeatCallbacks, HeartbeatMonitor } from "./connection/heartbeat.js";
export { createHeartbeatMonitor } from "./connection/heartbeat.js";
// -- Connection layer -------------------------------------------------------
export { decodeFrame, encodeFrame, generateCorrelationId } from "./connection/protocol.js";
export type { ReconnectState } from "./connection/reconnect.js";
export {
  computeReconnectDelay,
  createReconnectState,
  isCleanClose,
  nextAttempt,
  resetReconnectState,
} from "./connection/reconnect.js";
export type { Transport, TransportState } from "./connection/transport.js";
export { createTransport } from "./connection/transport.js";
export type {
  DeliveryManager,
  DeliveryManagerConfig,
  DeliveryManagerDeps,
} from "./delivery-manager.js";
// -- Delivery manager -------------------------------------------------------
export { createDeliveryManager, DEFAULT_DELIVERY_CONFIG } from "./delivery-manager.js";
export type { DiscoveryService, ServiceInfo } from "./discovery.js";
// -- Discovery & monitoring -------------------------------------------------
export { createDiscoveryService } from "./discovery.js";
export type { FrameCounterState, FrameCounters } from "./frame-counter.js";
// -- Frame counters ---------------------------------------------------------
export { createFrameCounters } from "./frame-counter.js";
export type { FrameDeduplicator } from "./frame-dedup.js";
// -- Frame deduplicator -----------------------------------------------------
export { createFrameDeduplicator } from "./frame-dedup.js";
export type { MemoryMetrics, MemoryMonitor } from "./monitor.js";
export { createMemoryMonitor } from "./monitor.js";
export type { FullKoiNode, KoiNode, NodeDeps, RecoveryResult, ThinKoiNode } from "./node.js";
// -- Main entry point -------------------------------------------------------
export { createNode } from "./node.js";
export type { ShutdownCallbacks, ShutdownEmit, ShutdownHandler } from "./shutdown.js";
// -- Shutdown ---------------------------------------------------------------
export { createShutdownHandler } from "./shutdown.js";
export type { ToolCallHandlerDeps } from "./tool-call-handler.js";
// -- Tool call handler ------------------------------------------------------
export {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  handleToolCall,
  isToolCallPayload,
} from "./tool-call-handler.js";
export { createFilesystemTool } from "./tools/filesystem.js";
export type { LocalResolver, ToolMeta } from "./tools/local-resolver.js";
// -- Tools ------------------------------------------------------------------
export { createLocalResolver } from "./tools/local-resolver.js";
export { createShellTool } from "./tools/shell.js";
export type {
  AdvertisedTool,
  AgentStatusPayload,
  AuthAckPayload,
  AuthChallengePayload,
  AuthConfig,
  AuthPayload,
  AuthResponsePayload,
  CapabilitiesPayload,
  CapacityReport,
  DiscoveryConfig,
  GatewayConnectionConfig,
  HandshakePayload,
  HeartbeatConfig,
  NodeCheckpoint,
  NodeConfig,
  NodeEvent,
  NodeEventListener,
  NodeEventType,
  NodeFrame,
  NodeFrameKind,
  NodeMode,
  NodePendingFrame,
  NodeRecoveryPlan,
  NodeSessionRecord,
  NodeSessionStore,
  NodeState,
  ResourcesConfig,
  ToolCallPayload,
  ToolErrorPayload,
  ToolResolverConfig,
  ToolResultPayload,
} from "./types.js";
// -- Configuration & types --------------------------------------------------
export { parseNodeConfig } from "./types.js";
export type { WriteQueue, WriteQueueConfig } from "./write-queue.js";
// -- Write queue ------------------------------------------------------------
export { createWriteQueue } from "./write-queue.js";
