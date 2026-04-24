export type { GatewayAuthenticator, HandshakeOptions, HandshakeResult } from "./auth.js";
export { handleHandshake } from "./auth.js";
export type { BackpressureMonitor } from "./backpressure.js";
export { createBackpressureMonitor } from "./backpressure.js";
export {
  CLOSE_CODE_MAP,
  CLOSE_CODES,
  type CloseCodeEntry,
  closeCodeLabel,
  isRetryableClose,
} from "./close-codes.js";
export {
  createGateway,
  type Gateway,
  type GatewayDeps,
  type SessionEvent,
} from "./gateway.js";
export {
  createAckFrame,
  createErrorFrame,
  createFrameIdGenerator,
  encodeFrame,
  type FrameIdGenerator,
  negotiateProtocol,
  parseConnectFrame,
  parseFrame,
} from "./protocol.js";
export {
  computeDispatchKey,
  type ResolvedRoute,
  resolveBinding,
  resolveRoute,
  validateBindingPattern,
} from "./routing.js";
export {
  type AcceptResult,
  createSequenceTracker,
  type SequenceTracker,
} from "./sequence-tracker.js";
export { createInMemorySessionStore, type SessionStore } from "./session-store.js";
export type {
  BunTransport,
  Transport,
  TransportConnection,
  TransportHandler,
  TransportSendResult,
} from "./transport.js";
export { createBunTransport } from "./transport.js";
export type {
  AuthResult,
  BackpressureState,
  ConnectClient,
  ConnectFrame,
  GatewayCapabilities,
  GatewayConfig,
  GatewayFrame,
  GatewayFrameKind,
  HandshakeAckPayload,
  HandshakeSnapshot,
  RouteBinding,
  RoutingConfig,
  RoutingContext,
  ScopingMode,
  Session,
} from "./types.js";
export { DEFAULT_GATEWAY_CONFIG } from "./types.js";
