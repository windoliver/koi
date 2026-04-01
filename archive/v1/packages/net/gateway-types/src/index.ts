/**
 * @koi/gateway-types — Shared wire protocol, session, routing, config, and store types.
 *
 * L0u package: depends on @koi/core only. Importable by all L2 gateway packages.
 */

export type {
  AdvertisedTool,
  AuthResult,
  BackpressureState,
  CapacityReport,
  ChannelBinding,
  ConnectClient,
  ConnectFrame,
  GatewayCapabilities,
  GatewayConfig,
  GatewayFrame,
  GatewayFrameKind,
  HandshakeAckPayload,
  HandshakeSnapshot,
  NodeRegistry,
  NodeRegistryEvent,
  RegisteredNode,
  ResumeRequest,
  RouteBinding,
  RoutingConfig,
  RoutingContext,
  SchedulerDef,
  ScopingMode,
  Session,
  SessionStore,
  SurfaceEntry,
  SurfaceStore,
  SurfaceStoreConfig,
  ToolAffinity,
  ToolRoutingConfig,
  ToolRoutingErrorCode,
} from "./types.js";
export {
  DEFAULT_GATEWAY_CONFIG,
  DEFAULT_TOOL_ROUTING_CONFIG,
  TOOL_ROUTING_ERROR_CODES,
} from "./types.js";
