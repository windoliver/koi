/**
 * @koi/channel-web — Browser/HTTP ChannelAdapter (L0u).
 *
 * Bun.serve-based: WebSocket push for outbound streaming, REST POST for
 * inbound messages. No external dependencies.
 */

export type {
  WebAuthContext,
  WebAuthResult,
  WebChannelAdapter,
  WebChannelConfig,
} from "./web-channel.js";
export { createWebChannel } from "./web-channel.js";
