/**
 * @koi/channel-mobile — WebSocket gateway adapter for native mobile apps (L2).
 *
 * Hosts a Bun WebSocket server. Strict single-client (rejects concurrent
 * connections). No in-process buffering — outbound while disconnected is
 * forwarded to an optional `pushNotifier` (APNs/FCM) provided by the host.
 */

export type { MobileChannelAdapter, MobileChannelConfig } from "./mobile-channel.js";
export { createMobileChannel, MobileNoDeliveryTargetError } from "./mobile-channel.js";
