/**
 * Discord messageReactionAdd/Remove → InboundMessage normalizer.
 *
 * Maps discord.js MessageReaction + User into an InboundMessage
 * with a `discord:reaction` custom block.
 */

import type { InboundMessage } from "@koi/core";
import type { MessageReaction, PartialMessageReaction, PartialUser, User } from "discord.js";

/** Whether the reaction was added or removed. */
type ReactionAction = "add" | "remove";

/**
 * Normalizes a discord.js reaction event into an InboundMessage.
 *
 * @param reaction - The reaction from messageReactionAdd/Remove.
 * @param user - The user who reacted.
 * @param action - Whether the reaction was added or removed.
 * @param botUserId - The bot's own user ID, used to filter self-reactions.
 * @returns InboundMessage or null if the reaction should be ignored.
 */
export function normalizeReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  action: ReactionAction,
  botUserId: string,
): InboundMessage | null {
  // Skip bot's own reactions
  if (user.id === botUserId) {
    return null;
  }

  const guildId = reaction.message.guildId;
  const channelId = reaction.message.channelId;
  const threadId = guildId !== null ? `${guildId}:${channelId}` : `dm:${user.id}`;

  const emoji = reaction.emoji;

  return {
    content: [
      {
        kind: "custom",
        type: "discord:reaction",
        data: {
          action,
          messageId: reaction.message.id,
          emoji: {
            id: emoji.id ?? null,
            name: emoji.name ?? null,
            animated: emoji.animated ?? false,
          },
        },
      },
    ],
    senderId: user.id,
    threadId,
    timestamp: Date.now(),
  };
}
