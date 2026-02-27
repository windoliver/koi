/**
 * Voice connection lifecycle management for Discord.
 *
 * Manages joining, leaving, reconnecting, and playing audio in voice channels.
 * Uses @discordjs/voice with config-injected dependencies for testability.
 *
 * Auto-reconnect: on disconnect, waits up to 5 seconds for the connection
 * to transition back to ready. After 3 failed attempts, destroys the connection.
 */

import type {
  AudioPlayer,
  AudioResource,
  CreateAudioPlayerOptions,
  CreateVoiceConnectionOptions,
  JoinVoiceChannelOptions,
  VoiceConnection,
  VoiceConnectionState,
} from "@discordjs/voice";
import { VoiceConnectionStatus } from "@discordjs/voice";

/** Maximum reconnect attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 3;

/** Timeout in ms waiting for reconnection. */
const RECONNECT_TIMEOUT_MS = 5000;

/** Represents a managed voice connection with audio playback. */
export interface DiscordVoiceConnection {
  readonly channelId: string;
  readonly guildId: string;
  readonly destroy: () => void;
  readonly playAudio: (resource: AudioResource) => void;
}

/** Dependencies injected for testability. */
export interface VoiceDeps {
  readonly joinVoiceChannel: (
    config: CreateVoiceConnectionOptions & JoinVoiceChannelOptions,
  ) => VoiceConnection;
  readonly createAudioPlayer: (options?: CreateAudioPlayerOptions) => AudioPlayer;
}

/** Tracks active voice connections by guild ID. */
export interface VoiceManager {
  readonly joinVoice: (
    guildId: string,
    channelId: string,
    adapterCreator: unknown,
  ) => DiscordVoiceConnection;
  readonly leaveVoice: (guildId: string) => void;
  readonly destroyAll: () => void;
}

/**
 * Creates a voice connection manager.
 *
 * @param deps - Injected voice functions (real or mock).
 * @returns A VoiceManager for joining/leaving voice channels.
 */
export function createVoiceManager(deps: VoiceDeps): VoiceManager {
  // Map<guildId, { connection, player, reconnectAttempts }>
  const connections = new Map<
    string,
    {
      readonly connection: VoiceConnection;
      readonly player: AudioPlayer;
      readonly channelId: string;
      // let requires justification: tracks reconnect attempts for auto-reconnect logic
      reconnectAttempts: number;
    }
  >();

  const joinVoice = (
    guildId: string,
    channelId: string,
    adapterCreator: unknown,
  ): DiscordVoiceConnection => {
    // Leave existing connection in this guild if any
    const existing = connections.get(guildId);
    if (existing !== undefined) {
      existing.connection.destroy();
      connections.delete(guildId);
    }

    const connection = deps.joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: adapterCreator as CreateVoiceConnectionOptions["adapterCreator"],
    });

    const player = deps.createAudioPlayer();
    connection.subscribe(player);

    const entry = { connection, player, channelId, reconnectAttempts: 0 };
    connections.set(guildId, entry);

    // Auto-reconnect on disconnect
    connection.on(
      "stateChange",
      (_oldState: VoiceConnectionState, newState: VoiceConnectionState) => {
        if (newState.status === VoiceConnectionStatus.Disconnected) {
          const current = connections.get(guildId);
          if (current === undefined) {
            return;
          }

          if (current.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            current.reconnectAttempts += 1;
            // Wait for reconnect with timeout
            const timeout = setTimeout(() => {
              const stillActive = connections.get(guildId);
              if (
                stillActive !== undefined &&
                stillActive.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS
              ) {
                stillActive.connection.destroy();
                connections.delete(guildId);
              }
            }, RECONNECT_TIMEOUT_MS);
            // Prevent timeout from keeping the process alive
            if (typeof timeout === "object" && "unref" in timeout) {
              (timeout as { unref: () => void }).unref();
            }
          } else {
            connection.destroy();
            connections.delete(guildId);
          }
        } else if (newState.status === VoiceConnectionStatus.Ready) {
          // Reset reconnect counter on successful reconnect
          const current = connections.get(guildId);
          if (current !== undefined) {
            current.reconnectAttempts = 0;
          }
        }
      },
    );

    return {
      channelId,
      guildId,
      destroy: () => {
        connection.destroy();
        connections.delete(guildId);
      },
      playAudio: (resource: AudioResource) => {
        player.play(resource);
      },
    };
  };

  const leaveVoice = (guildId: string): void => {
    const entry = connections.get(guildId);
    if (entry !== undefined) {
      entry.connection.destroy();
      connections.delete(guildId);
    }
  };

  const destroyAll = (): void => {
    for (const [guildId, entry] of connections) {
      entry.connection.destroy();
      connections.delete(guildId);
    }
  };

  return { joinVoice, leaveVoice, destroyAll };
}
