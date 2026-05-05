/**
 * @koi/channel-mobile — WebSocket gateway adapter for native mobile apps (L2).
 *
 * Hosts a Bun WebSocket server. Single-client semantics, in-memory offline
 * queue, optional push-notifier hook for APNs/FCM.
 */

export type { MobileChannelAdapter, MobileChannelConfig } from "./mobile-channel.js";
export { createMobileChannel } from "./mobile-channel.js";
