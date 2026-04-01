/**
 * @koi/channel-discord — discord.js integration.
 *
 * Creates a ChannelAdapter for Discord bots using discord.js 14.
 * Supports text messages, slash commands, buttons, select menus,
 * embeds, components, voice channels, and all Discord-specific features.
 *
 * Usage:
 *   const adapter = createDiscordChannel({
 *     token: "...",
 *     features: { text: true, voice: true, slashCommands: true },
 *   });
 *   await adapter.connect();
 *
 * threadId convention:
 * - Guild channels: "guildId:channelId"
 * - DM channels: "dm:userId"
 * - Voice channels: "guildId:voiceChannelId"
 *
 * Voice: call adapter.joinVoice(guildId, channelId) after connect().
 * Slash commands: call adapter.registerCommands(commands) to register globally.
 */

import {
  createAudioPlayer as djsCreateAudioPlayer,
  joinVoiceChannel as djsJoinVoiceChannel,
} from "@discordjs/voice";
import { createChannelAdapter } from "@koi/channel-base";
import type { ChannelAdapter, ChannelCapabilities, ChannelStatus } from "@koi/core";
import { Client, Events, Options } from "discord.js";
import type { DiscordChannelConfig } from "./config.js";
import { computeIntents, resolveFeatures } from "./intents.js";
import type { DiscordEvent } from "./normalize.js";
import { createNormalizer } from "./normalize.js";
import type { DiscordSendTarget } from "./platform-send.js";
import { discordSend } from "./platform-send.js";
import type { DiscordSlashCommand } from "./slash-commands.js";
import { registerCommands } from "./slash-commands.js";
import type { DiscordVoiceConnection, VoiceDeps } from "./voice.js";
import { createVoiceManager } from "./voice.js";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const DISCORD_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: true,
  video: true,
  threads: true,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

// ---------------------------------------------------------------------------
// Extended adapter interface
// ---------------------------------------------------------------------------

/** ChannelAdapter extended with Discord-specific methods. */
export interface DiscordChannelAdapter extends ChannelAdapter {
  /** Registers global slash commands. Requires applicationId in config. */
  readonly registerCommands: (commands: readonly DiscordSlashCommand[]) => Promise<void>;
  /** Joins a voice channel. Returns a handle to play audio or destroy. */
  readonly joinVoice: (guildId: string, channelId: string) => DiscordVoiceConnection;
  /** Leaves a voice channel in the specified guild. */
  readonly leaveVoice: (guildId: string) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a Discord ChannelAdapter using discord.js.
 *
 * @param config - Bot token, features, and optional hooks.
 * @returns A DiscordChannelAdapter satisfying the @koi/core ChannelAdapter contract.
 */
export function createDiscordChannel(config: DiscordChannelConfig): DiscordChannelAdapter {
  const features = resolveFeatures(config.features);
  const intents = computeIntents(config.features);

  const client =
    config._client ??
    new Client({
      intents: [...intents],
      makeCache: Options.cacheWithLimits({
        MessageManager: 50,
        GuildMemberManager: 200,
        PresenceManager: 0,
      }),
    });

  // Voice manager with injected or real @discordjs/voice functions
  const voiceDeps: VoiceDeps = {
    joinVoiceChannel: config._joinVoiceChannel ?? djsJoinVoiceChannel,
    createAudioPlayer: config._createAudioPlayer ?? djsCreateAudioPlayer,
  };

  // AbortController for listener cleanup on disconnect
  const controller = new AbortController();

  const voiceManager = createVoiceManager(voiceDeps);

  // let requires justification: botUserId determined after login
  let botUserId = client.user?.id ?? "unknown";

  const getChannel = (threadId: string): DiscordSendTarget | undefined => {
    // Parse threadId → channelId
    const parts = threadId.split(":");
    const channelId = parts.length >= 2 ? parts[1] : parts[0];
    if (channelId === undefined) {
      return undefined;
    }
    const channel = client.channels.cache.get(channelId);
    if (channel === undefined || channel === null) {
      return undefined;
    }
    if (!("send" in channel)) {
      return undefined;
    }
    return channel as unknown as DiscordSendTarget;
  };

  const platformSendStatus = async (status: ChannelStatus): Promise<void> => {
    const threadId = status.messageRef;
    if (threadId === undefined) {
      return;
    }
    if (status.kind === "processing") {
      const channel = getChannel(threadId);
      if (channel !== undefined) {
        try {
          await channel.sendTyping();
        } catch (e: unknown) {
          console.error("[channel-discord] sendTyping failed:", e);
        }
      }
    }
  };

  const base = createChannelAdapter<DiscordEvent>({
    name: "discord",
    capabilities: DISCORD_CAPABILITIES,

    platformConnect: async () => {
      await client.login(config.token);
      botUserId = client.user?.id ?? botUserId;
    },

    platformDisconnect: async () => {
      controller.abort();
      voiceManager.destroyAll();
      client.destroy();
    },

    platformSend: async (message) => {
      await discordSend(getChannel, message);
    },

    onPlatformEvent: (handler) => {
      // Text messages
      if (features.text) {
        client.on(Events.MessageCreate, (message) => {
          handler({ kind: "message", message });
        });
      }

      // Slash commands, buttons, select menus
      if (features.slashCommands) {
        client.on(Events.InteractionCreate, (interaction) => {
          handler({ kind: "interaction", interaction });
        });
      }

      // Voice state updates
      if (features.voice) {
        client.on(Events.VoiceStateUpdate, (oldState, newState) => {
          handler({ kind: "voiceStateUpdate", oldState, newState });
        });
      }

      // Reactions
      if (features.reactions) {
        client.on(Events.MessageReactionAdd, (reaction, user) => {
          handler({ kind: "reactionAdd", reaction, user });
        });
        client.on(Events.MessageReactionRemove, (reaction, user) => {
          handler({ kind: "reactionRemove", reaction, user });
        });
      }

      return () => {
        client.removeAllListeners();
      };
    },

    // Wrap in a lambda so the normalizer reads the *current* botUserId value
    // (updated by platformConnect after login), not the initial "unknown" value.
    normalize: (event: DiscordEvent) => createNormalizer(botUserId)(event),
    platformSendStatus,
    ...(config.onHandlerError !== undefined && { onHandlerError: config.onHandlerError }),
    ...(config.queueWhenDisconnected !== undefined && {
      queueWhenDisconnected: config.queueWhenDisconnected,
    }),
  });

  return {
    ...base,
    registerCommands: async (commands: readonly DiscordSlashCommand[]): Promise<void> => {
      if (config.applicationId === undefined) {
        throw new Error(
          "[channel-discord] Cannot register commands: applicationId is required in config.",
        );
      }
      await registerCommands(config.token, config.applicationId, commands);
    },
    joinVoice: (guildId: string, channelId: string): DiscordVoiceConnection => {
      const guild = client.guilds.cache.get(guildId);
      const adapterCreator = guild?.voiceAdapterCreator ?? {};
      return voiceManager.joinVoice(guildId, channelId, adapterCreator);
    },
    leaveVoice: (guildId: string): void => {
      voiceManager.leaveVoice(guildId);
    },
  };
}
