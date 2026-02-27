/**
 * @koi/channel-chat-sdk — Multi-platform channel adapter via Vercel Chat SDK.
 *
 * Wraps Slack, Discord, Teams, Google Chat, GitHub, and Linear into
 * Koi ChannelAdapters using a single shared Chat SDK instance.
 *
 * @example
 * ```typescript
 * import { createChatSdkChannels } from "@koi/channel-chat-sdk";
 *
 * const adapters = createChatSdkChannels({
 *   platforms: [
 *     { platform: "slack" },
 *     { platform: "discord" },
 *   ],
 * });
 *
 * for (const adapter of adapters) {
 *   await adapter.connect();
 * }
 * ```
 */

export type {
  ChatSdkChannelConfig,
  DiscordPlatformConfig,
  GchatPlatformConfig,
  GithubPlatformConfig,
  LinearPlatformConfig,
  PlatformConfig,
  PlatformName,
  SlackPlatformConfig,
  TeamsPlatformConfig,
} from "./config.js";
export { validateChatSdkChannelConfig } from "./config.js";
export type { ChatSdkChannelAdapter } from "./create-chat-sdk-channels.js";
export { createChatSdkChannels } from "./create-chat-sdk-channels.js";
export { descriptor } from "./descriptor.js";
