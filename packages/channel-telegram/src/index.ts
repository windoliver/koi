/**
 * @koi/channel-telegram — grammY Telegram channel adapter.
 *
 * Creates a ChannelAdapter for Telegram bots. Supports long polling (default)
 * and webhook deployment modes.
 *
 * @example
 * ```typescript
 * import { createTelegramChannel } from "@koi/channel-telegram";
 *
 * const channel = createTelegramChannel({
 *   token: process.env.TELEGRAM_BOT_TOKEN!,
 *   deployment: { mode: "polling" },
 * });
 * await channel.connect();
 * ```
 */

export { descriptor } from "./descriptor.js";
export type {
  TelegramChannelAdapter,
  TelegramChannelConfig,
  TelegramDeployment,
} from "./telegram-channel.js";
export { createTelegramChannel } from "./telegram-channel.js";
