/**
 * Discord messageCreate → InboundMessage normalizer.
 *
 * Maps discord.js Message objects to InboundMessage blocks.
 * Returns null for bot's own messages and system events.
 *
 * threadId convention: "guildId:channelId" for guild messages,
 * "dm:userId" for DM messages, "guildId:threadId" for thread messages.
 */

import { file, image, text } from "@koi/channel-base";
import type { InboundMessage } from "@koi/core";
import type { Message } from "discord.js";

/**
 * Normalizes a discord.js Message into an InboundMessage.
 *
 * @param message - The discord.js Message from messageCreate event.
 * @param botUserId - The bot's own user ID, used to filter self-messages.
 * @returns InboundMessage or null if the message should be ignored.
 */
export function normalizeMessage(message: Message, botUserId: string): InboundMessage | null {
  // Skip bot's own messages
  if (message.author.bot && message.author.id === botUserId) {
    return null;
  }

  const senderId = message.author.id;
  const timestamp = message.createdTimestamp;
  const threadId = resolveThreadId(message);

  const blocks: import("@koi/core").ContentBlock[] = [];

  // Text content
  if (message.content.length > 0) {
    blocks.push(text(message.content));
  }

  // Attachments (images, files)
  for (const [, attachment] of message.attachments) {
    const contentType = attachment.contentType;
    if (contentType?.startsWith("image/")) {
      blocks.push(image(attachment.url, attachment.name));
    } else {
      blocks.push(file(attachment.url, contentType ?? "application/octet-stream", attachment.name));
    }
  }

  // Stickers → custom blocks
  for (const [, sticker] of message.stickers) {
    blocks.push({
      kind: "custom",
      type: "discord:sticker",
      data: { id: sticker.id, name: sticker.name, format: sticker.format },
    });
  }

  // No content at all — ignore (e.g., system messages with no text)
  if (blocks.length === 0) {
    return null;
  }

  // Build metadata with message reference if this is a reply
  const reference = message.reference;
  const metadata =
    reference !== undefined && reference !== null && reference.messageId !== undefined
      ? { replyToMessageId: reference.messageId }
      : undefined;

  return {
    content: blocks,
    senderId,
    threadId,
    timestamp,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/** Resolves the threadId from a Message based on context. */
function resolveThreadId(message: Message): string {
  const guildId = message.guildId;

  // DM messages
  if (guildId === null) {
    return `dm:${message.author.id}`;
  }

  // Thread messages — use the thread channel's ID
  if (message.channel.isThread()) {
    return `${guildId}:${message.channelId}`;
  }

  // Regular guild channel messages
  return `${guildId}:${message.channelId}`;
}
