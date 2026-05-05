/**
 * @koi/channel-discord — Discord ChannelAdapter (L2).
 */

export type {
  DiscordChannelAdapter,
  DiscordChannelConfig,
  DiscordClientLike,
  DiscordIntent,
  DiscordSendPayload,
  DiscordSendTargetLike,
  DiscordSlashCommand,
} from "./discord-channel.js";
export { createDiscordChannel, splitText } from "./discord-channel.js";
export type {
  DiscordAttachment,
  DiscordAuthor,
  DiscordButtonInteractionLike,
  DiscordEvent,
  DiscordMessageLike,
  DiscordSlashCommandLike,
  DiscordSlashCommandOption,
} from "./normalize.js";
export { createNormalizer } from "./normalize.js";
