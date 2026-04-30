/**
 * Shared gateway wire-protocol types — L0u.
 *
 * Extracted from @koi/gateway so that L2 feature packages (gateway-webhook,
 * gateway-canvas, …) can share types without creating L2→L2 import cycles.
 * No logic, no side effects — pure type and readonly-constant exports only.
 */

export type {
  Gateway,
  GatewayFrame,
  GatewayFrameKind,
  RoutingContext,
  Session,
} from "./types.js";
