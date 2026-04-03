/**
 * Configuration types for @koi/channel-discord.
 *
 * DiscordFeatures controls which Gateway intents are requested.
 * DiscordChannelConfig is the input to createDiscordChannel().
 */

import type {
  AudioPlayer,
  CreateAudioPlayerOptions,
  CreateVoiceConnectionOptions,
  JoinVoiceChannelOptions,
  VoiceConnection,
} from "@discordjs/voice";
import type { InboundMessage } from "@koi/core";
import type { Client } from "discord.js";

/** Feature flags that drive intent computation and event listener registration. */
export interface DiscordFeatures {
  /** Enable text message handling. Default: true. Requires MessageContent privileged intent. */
  readonly text?: boolean;
  /** Enable voice channel support. Default: false. Requires GuildVoiceStates intent. */
  readonly voice?: boolean;
  /** Enable reaction tracking. Default: false. Requires GuildMessageReactions intent. */
  readonly reactions?: boolean;
  /** Enable thread support. Default: true. Included with Guilds intent. */
  readonly threads?: boolean;
  /** Enable slash command handling. Default: true. No additional intents needed. */
  readonly slashCommands?: boolean;
}

/** Configuration for createDiscordChannel(). */
export interface DiscordChannelConfig {
  /** Discord bot token. */
  readonly token: string;
  /** Application ID. Required for registerCommands(). */
  readonly applicationId?: string;
  /** Feature flags controlling intents and listeners. */
  readonly features?: DiscordFeatures;
  /**
   * Called when a registered message handler throws or rejects.
   * Defaults to console.error. The channel continues processing events.
   */
  readonly onHandlerError?: (err: unknown, message: InboundMessage) => void;
  /**
   * When true, send() called while disconnected buffers the message and
   * flushes on the next connect(). When false (default), send() throws.
   */
  readonly queueWhenDisconnected?: boolean;
  /**
   * For testing only: inject a pre-configured Client instance.
   * @internal
   */
  readonly _client?: Client;
  /**
   * For testing only: inject a mock joinVoiceChannel function.
   * @internal
   */
  readonly _joinVoiceChannel?: (
    config: CreateVoiceConnectionOptions & JoinVoiceChannelOptions,
  ) => VoiceConnection;
  /**
   * For testing only: inject a mock createAudioPlayer function.
   * @internal
   */
  readonly _createAudioPlayer?: (options?: CreateAudioPlayerOptions) => AudioPlayer;
}
