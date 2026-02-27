/**
 * @koi/channel-discord — Discord.js channel adapter.
 *
 * Creates a ChannelAdapter for Discord bots using discord.js.
 * Supports text messages, slash commands, buttons, select menus,
 * voice channels, embeds, and components.
 *
 * @example
 * ```typescript
 * import { createDiscordChannel } from "@koi/channel-discord";
 *
 * const channel = createDiscordChannel({
 *   token: process.env.DISCORD_BOT_TOKEN!,
 *   features: { text: true, voice: true },
 * });
 * await channel.connect();
 * ```
 */

export type { DiscordChannelConfig, DiscordFeatures } from "./config.js";
export { descriptor } from "./descriptor.js";
export type { DiscordChannelAdapter } from "./discord-channel.js";
export { createDiscordChannel } from "./discord-channel.js";
export type { DiscordSlashCommand } from "./slash-commands.js";
export { registerCommands } from "./slash-commands.js";
