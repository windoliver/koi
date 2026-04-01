/**
 * Gateway types — re-exports from @koi/gateway-types for backward compatibility,
 * plus gateway-specific types not shared with peer L2 packages.
 */

// Re-export all shared types from @koi/gateway-types
export type {
  AuthResult,
  BackpressureState,
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
} from "@koi/gateway-types";

export {
  DEFAULT_GATEWAY_CONFIG,
  DEFAULT_TOOL_ROUTING_CONFIG,
  TOOL_ROUTING_ERROR_CODES,
} from "@koi/gateway-types";
