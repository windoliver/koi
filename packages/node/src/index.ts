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
export type { AuthHandshake, AuthHandshakeConfig } from "./connection/auth.js";
export { createAuthHandshake, createAuthPayload, signChallenge } from "./connection/auth.js";
export type { HeartbeatCallbacks, HeartbeatMonitor } from "./connection/heartbeat.js";
export { createHeartbeatMonitor } from "./connection/heartbeat.js";
// -- Connection layer -------------------------------------------------------
export { decodeFrame, encodeFrame, generateCorrelationId } from "./connection/protocol.js";
export type { ReconnectState } from "./connection/reconnect.js";
export {
  calculateReconnectDelay,
  createReconnectState,
  isCleanClose,
  nextAttempt,
  resetReconnectState,
} from "./connection/reconnect.js";
export type { Transport, TransportState } from "./connection/transport.js";
export { createTransport } from "./connection/transport.js";
export type { DiscoveryService, ServiceInfo } from "./discovery.js";
// -- Discovery & monitoring -------------------------------------------------
export { createDiscoveryService } from "./discovery.js";
export type { MemoryMetrics, MemoryMonitor } from "./monitor.js";
export { createMemoryMonitor } from "./monitor.js";
export type { KoiNode } from "./node.js";
// -- Main entry point -------------------------------------------------------
export { createNode } from "./node.js";
export type { ShutdownCallbacks, ShutdownHandler } from "./shutdown.js";
// -- Shutdown ---------------------------------------------------------------
export { createShutdownHandler } from "./shutdown.js";
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
  NodeConfig,
  NodeEvent,
  NodeEventListener,
  NodeEventType,
  NodeFrame,
  NodeFrameType,
  NodeMode,
  NodeState,
  ResourcesConfig,
  ToolCallPayload,
  ToolErrorPayload,
  ToolResolverConfig,
  ToolResultPayload,
} from "./types.js";
// -- Configuration & types --------------------------------------------------
export { parseNodeConfig } from "./types.js";
