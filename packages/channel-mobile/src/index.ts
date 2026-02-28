/**
 * @koi/channel-mobile — WebSocket gateway adapter for native mobile apps.
 *
 * Creates a ChannelAdapter backed by a Bun WebSocket server. Mobile clients
 * connect and exchange JSON frames for messaging and tool invocation.
 *
 * @example
 * ```typescript
 * import { createMobileChannel } from "@koi/channel-mobile";
 *
 * const channel = createMobileChannel({ port: 8080 });
 * await channel.connect();
 * ```
 */

export type { MobileChannelAdapter, MobileChannelConfig, MobileFeatures } from "./config.js";
export {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MOBILE_PORT,
} from "./config.js";
export { descriptor } from "./descriptor.js";
export { createMobileChannel } from "./mobile-channel.js";
export type { MobileInboundFrame, MobileOutboundFrame } from "./protocol.js";
export type { RateLimitConfig, RateLimitResult } from "./rate-limit.js";
export { createRateLimiter, DEFAULT_RATE_LIMIT } from "./rate-limit.js";
export { CAMERA_TOOL, DEFAULT_MOBILE_TOOLS, GPS_TOOL, HAPTIC_TOOL } from "./tools.js";
