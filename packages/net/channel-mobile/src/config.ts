/**
 * Configuration types for @koi/channel-mobile.
 */

import type { ChannelAdapter, InboundMessage, ToolDescriptor } from "@koi/core";
import type { RateLimitConfig } from "./rate-limit.js";

/** Features supported by the mobile channel. */
export interface MobileFeatures {
  /** Enable heartbeat ping/pong. Default: true */
  readonly heartbeat?: boolean;
  /** Enable bearer token auth on connect. Default: false */
  readonly requireAuth?: boolean;
  /** Per-client rate limiting config. Disabled when undefined. */
  readonly rateLimit?: RateLimitConfig;
}

/** Configuration for the mobile WebSocket channel. */
export interface MobileChannelConfig {
  /** WebSocket server port. */
  readonly port: number;
  /** WebSocket server hostname. Default: "0.0.0.0" */
  readonly hostname?: string;
  /** Bearer token for auth frame validation. Required when features.requireAuth is true. */
  readonly authToken?: string;
  /** Mobile-native tool descriptors (camera, GPS, etc.) exposed to the agent. */
  readonly tools?: readonly ToolDescriptor[];
  /** Heartbeat ping interval in ms. Default: 30000 */
  readonly heartbeatIntervalMs?: number;
  /** Close connection after this idle duration in ms. Default: 120000 */
  readonly idleTimeoutMs?: number;
  /** Max WebSocket payload size in bytes. Default: 1048576 (1MB) */
  readonly maxPayloadBytes?: number;
  /** Optional feature toggles. */
  readonly features?: MobileFeatures;
  /** Error handler for message processing failures. */
  readonly onHandlerError?: (err: unknown, message: InboundMessage) => void;
  /** Queue outbound messages when disconnected. Default: false */
  readonly queueWhenDisconnected?: boolean;
  /** @internal Test injection for Bun.serve() server. */
  readonly _server?: unknown;
}

/** Extended adapter exposing the mobile tool surface and connection info. */
export interface MobileChannelAdapter extends ChannelAdapter {
  /** Tool descriptors available to the mobile client. */
  readonly tools: readonly ToolDescriptor[];
  /** Number of currently connected WebSocket clients. */
  readonly connectedClients: () => number;
}

/** Default configuration values. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576;
export const DEFAULT_MOBILE_PORT = 8080;
