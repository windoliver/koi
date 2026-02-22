/**
 * @koi/gateway — WebSocket control plane (Layer 2)
 *
 * Delivery semantics: ordering, deduplication, backpressure, authentication.
 * Depends on @koi/core only.
 */

// auth
export type { GatewayAuthenticator, HandshakeResult } from "./auth.js";
export { handleHandshake, startHeartbeatSweep } from "./auth.js";
// backpressure
export type { BackpressureMonitor } from "./backpressure.js";
export { createBackpressureMonitor } from "./backpressure.js";
// gateway
export type { Gateway, GatewayDeps } from "./gateway.js";
export { createGateway } from "./gateway.js";
// protocol
export { encodeFrame, parseFrame } from "./protocol.js";

// sequence tracker
export type { AcceptResult, SequenceTracker } from "./sequence-tracker.js";
export { createSequenceTracker } from "./sequence-tracker.js";
// session store
export type { SessionStore } from "./session-store.js";
export { createInMemorySessionStore } from "./session-store.js";
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
  GatewayConfig,
  GatewayFrame,
  GatewayFrameKind,
  Session,
} from "./types.js";
export { DEFAULT_GATEWAY_CONFIG } from "./types.js";
