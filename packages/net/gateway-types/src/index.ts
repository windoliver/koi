/**
 * @koi/gateway-types — Shared wire protocol, session, routing, and config types.
 *
 * L0u package: depends on @koi/core only. Importable by all L2 gateway packages.
 */

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
  ResumeRequest,
  RouteBinding,
  RoutingConfig,
  RoutingContext,
  SchedulerDef,
  ScopingMode,
  Session,
  ToolAffinity,
  ToolRoutingConfig,
  ToolRoutingErrorCode,
} from "./types.js";
export {
  DEFAULT_GATEWAY_CONFIG,
  DEFAULT_TOOL_ROUTING_CONFIG,
  TOOL_ROUTING_ERROR_CODES,
} from "./types.js";
