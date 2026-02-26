/**
 * @koi/gateway — WebSocket control plane (Layer 2)
 *
 * Delivery semantics: ordering, deduplication, backpressure, authentication,
 * routing, webhook ingestion, scheduler dispatch, node registration,
 * session resumption, and channel binding.
 * Depends on @koi/core only.
 */

// auth
export type {
  GatewayAuthenticator,
  HandshakeOptions,
  HandshakeResult,
  SweepError,
} from "./auth.js";
export { handleHandshake, startHeartbeatSweep } from "./auth.js";
// backpressure
export type { BackpressureMonitor } from "./backpressure.js";
export { createBackpressureMonitor } from "./backpressure.js";
// canvas routes
export type {
  CanvasAuthenticator,
  CanvasAuthResult,
  CanvasRouteConfig,
  CanvasServer,
} from "./canvas-routes.js";
export { createCanvasServer } from "./canvas-routes.js";
// canvas SSE
export type {
  CanvasSseConfig,
  CanvasSseManager,
  SseEvent,
  SseSubscriber,
} from "./canvas-sse.js";
export { createCanvasSseManager, formatSseEvent } from "./canvas-sse.js";
// canvas store
export type {
  SurfaceEntry,
  SurfaceStore,
  SurfaceStoreConfig,
} from "./canvas-store.js";
export { computeContentHash, createInMemorySurfaceStore } from "./canvas-store.js";
// gateway
export type { Gateway, GatewayDeps, SessionEvent } from "./gateway.js";
export { createGateway } from "./gateway.js";
// http helpers
export { jsonResponse, matchPath, parseJsonBody } from "./http-helpers.js";
// node handler
export type {
  CapabilitiesPayload,
  HandshakePayload,
  NodeFrame,
  NodeFrameKind,
} from "./node-handler.js";
export {
  encodeNodeFrame,
  parseNodeFrame,
  peekFrameKind,
  validateCapabilitiesPayload,
  validateCapacityPayload,
  validateHandshakePayload,
} from "./node-handler.js";
// node registry
export type {
  AdvertisedTool,
  CapacityReport,
  NodeRegistry,
  NodeRegistryEvent,
  RegisteredNode,
} from "./node-registry.js";
export { createInMemoryNodeRegistry } from "./node-registry.js";
// protocol
export type { FrameIdGenerator } from "./protocol.js";
export {
  createAckFrame,
  createErrorFrame,
  createFrameIdGenerator,
  encodeFrame,
  negotiateProtocol,
  parseConnectFrame,
  parseFrame,
} from "./protocol.js";
// routing
export type { ResolvedRoute } from "./routing.js";
export {
  computeDispatchKey,
  resolveBinding,
  resolveRoute,
  validateBindingPattern,
} from "./routing.js";
// scheduler
export type { GatewayScheduler, SchedulerDispatcher } from "./scheduler.js";
export { createScheduler } from "./scheduler.js";
// sequence tracker
export type { AcceptResult, SequenceTracker } from "./sequence-tracker.js";
export { createSequenceTracker } from "./sequence-tracker.js";
// session store
export type { SessionStore } from "./session-store.js";
export { createInMemorySessionStore } from "./session-store.js";
// tool router
export type {
  CompiledAffinity,
  RouteResult,
  ToolAffinity,
  ToolRouter,
  ToolRouterDeps,
  ToolRoutingConfig,
  ToolRoutingErrorCode,
} from "./tool-router.js";
export {
  compileAffinities,
  createToolRouter,
  DEFAULT_TOOL_ROUTING_CONFIG,
  matchAffinity,
  resolveTargetNode,
  TOOL_ROUTING_ERROR_CODES,
} from "./tool-router.js";
// transport
export type {
  BunTransport,
  Transport,
  TransportConnection,
  TransportHandler,
  TransportSendResult,
} from "./transport.js";
export { createBunTransport } from "./transport.js";
// types
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
} from "./types.js";
export { DEFAULT_GATEWAY_CONFIG } from "./types.js";
// webhook
export type {
  WebhookAuthenticator,
  WebhookAuthResult,
  WebhookConfig,
  WebhookDispatcher,
  WebhookServer,
} from "./webhook.js";
export { createWebhookServer } from "./webhook.js";
