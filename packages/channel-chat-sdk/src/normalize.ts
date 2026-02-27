/**
 * Normalizer: Chat SDK Message + Thread → Koi InboundMessage.
 *
 * One normalizer handles all 6 platforms because the Chat SDK
 * already normalizes platform events into a unified Message type.
 */

import type { MessageNormalizer } from "@koi/channel-base";
import type { ContentBlock, InboundMessage } from "@koi/core";
import type { ChatSdkEvent } from "./types.js";

/**
 * Maps a Chat SDK attachment to a Koi ContentBlock, or null if unmappable.
 */
function mapAttachment(
  attachment: Readonly<{
    type: string;
    url?: string;
    name?: string;
    mimeType?: string;
  }>,
): ContentBlock | null {
  if (attachment.url === undefined) {
    return null;
  }

  if (attachment.type === "image") {
    const base: ContentBlock = { kind: "image", url: attachment.url };
    if (attachment.name !== undefined) {
      return { kind: "image", url: attachment.url, alt: attachment.name };
    }
    return base;
  }

  if (attachment.type === "file" || attachment.type === "video" || attachment.type === "audio") {
    const mimeType = attachment.mimeType ?? "application/octet-stream";
    if (attachment.name !== undefined) {
      return { kind: "file", url: attachment.url, mimeType, name: attachment.name };
    }
    return { kind: "file", url: attachment.url, mimeType };
  }

  return null;
}

/**
 * Normalizes a Chat SDK event (Thread + Message) into a Koi InboundMessage.
 *
 * Returns null for:
 * - Bot's own messages (author.isMe === true)
 * - Empty messages (no text and no attachments)
 */
export function normalizeChatSdkEvent(event: ChatSdkEvent): InboundMessage | null {
  const { thread, message } = event;

  // Skip bot's own messages to prevent echo loops
  if (message.author.isMe) {
    return null;
  }

  const textBlocks: readonly ContentBlock[] =
    message.text.length > 0 ? [{ kind: "text", text: message.text }] : [];

  const attachmentBlocks: readonly ContentBlock[] = message.attachments
    .map(mapAttachment)
    .filter((b): b is ContentBlock => b !== null);

  const content: readonly ContentBlock[] = [...textBlocks, ...attachmentBlocks];

  // Skip completely empty messages
  if (content.length === 0) {
    return null;
  }

  const timestamp =
    message.metadata.dateSent instanceof Date ? message.metadata.dateSent.getTime() : Date.now();

  const base: InboundMessage = {
    content,
    senderId: message.author.userId,
    threadId: thread.id,
    timestamp,
  };

  if (message.isMention === true) {
    return { ...base, metadata: { isMention: true } };
  }

  return base;
}

/**
 * MessageNormalizer-typed reference for use in createChannelAdapter config.
 */
export const normalize: MessageNormalizer<ChatSdkEvent> = normalizeChatSdkEvent;
