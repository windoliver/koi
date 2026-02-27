/**
 * Discord voiceStateUpdate → InboundMessage normalizer.
 *
 * Maps voice state changes (join, leave, move, mute, deafen)
 * to InboundMessage with a custom block type "discord:voice_state".
 */

import { custom } from "@koi/channel-base";
import type { InboundMessage } from "@koi/core";
import type { VoiceState } from "discord.js";

/** Voice state change actions derived from old/new state comparison. */
type VoiceAction = "join" | "leave" | "move" | "mute" | "deafen" | "update";

/**
 * Normalizes a voiceStateUpdate event pair into an InboundMessage.
 *
 * @param oldState - The previous voice state.
 * @param newState - The new voice state.
 * @param botUserId - The bot's own user ID, used to filter self-events.
 * @returns InboundMessage or null if the event should be ignored.
 */
export function normalizeVoiceState(
  oldState: VoiceState,
  newState: VoiceState,
  botUserId: string,
): InboundMessage | null {
  // Skip the bot's own voice state changes
  if (newState.member?.user.id === botUserId) {
    return null;
  }

  const senderId = newState.member?.user.id ?? newState.id;
  const guildId = newState.guild.id;
  const action = determineVoiceAction(oldState, newState);

  // Use new channel for join/move, old channel for leave
  const channelId = newState.channelId ?? oldState.channelId;
  const threadId = channelId !== null ? `${guildId}:${channelId}` : guildId;

  return {
    content: [
      custom("discord:voice_state", {
        action,
        guildId,
        channelId: newState.channelId,
        oldChannelId: oldState.channelId,
        selfMute: newState.selfMute,
        selfDeaf: newState.selfDeaf,
        serverMute: newState.serverMute,
        serverDeaf: newState.serverDeaf,
      }),
    ],
    senderId,
    threadId,
    timestamp: Date.now(),
  };
}

/** Determines the voice action by comparing old and new states. */
function determineVoiceAction(oldState: VoiceState, newState: VoiceState): VoiceAction {
  // Join: no previous channel, now in a channel
  if (oldState.channelId === null && newState.channelId !== null) {
    return "join";
  }

  // Leave: had a channel, now gone
  if (oldState.channelId !== null && newState.channelId === null) {
    return "leave";
  }

  // Move: changed channels
  if (
    oldState.channelId !== null &&
    newState.channelId !== null &&
    oldState.channelId !== newState.channelId
  ) {
    return "move";
  }

  // Mute state changed
  if (oldState.selfMute !== newState.selfMute || oldState.serverMute !== newState.serverMute) {
    return "mute";
  }

  // Deafen state changed
  if (oldState.selfDeaf !== newState.selfDeaf || oldState.serverDeaf !== newState.serverDeaf) {
    return "deafen";
  }

  return "update";
}
