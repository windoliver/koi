/**
 * WhatsApp event normalizer.
 *
 * Converts Baileys WAMessage events into InboundMessage objects.
 * Handles text, images, documents, audio, video, stickers, and reactions.
 */

import { custom, file, image, text } from "@koi/channel-base";
import type { ContentBlock, InboundMessage } from "@koi/core";

/** Simplified Baileys WAMessage shape (subset we need). */
export interface WAMessage {
  readonly key: {
    readonly remoteJid?: string | null;
    readonly fromMe?: boolean | null;
    readonly id?: string | null;
    readonly participant?: string | null;
  };
  readonly message?: WAMessageContent | null;
  readonly messageTimestamp?: number | bigint | null;
  readonly pushName?: string | null;
}

/** Simplified message content shape. */
export interface WAMessageContent {
  readonly conversation?: string | null;
  readonly extendedTextMessage?: { readonly text?: string | null } | null;
  readonly imageMessage?: WAMediaMessage | null;
  readonly documentMessage?: WADocumentMessage | null;
  readonly audioMessage?: WAAudioMessage | null;
  readonly videoMessage?: WAMediaMessage | null;
  readonly stickerMessage?: WAStickerMessage | null;
  readonly reactionMessage?: WAReactionMessage | null;
  /** Ephemeral (disappearing) message wrapper. */
  readonly ephemeralMessage?: { readonly message?: WAMessageContent | null } | null;
  /** View-once message wrapper. */
  readonly viewOnceMessage?: { readonly message?: WAMessageContent | null } | null;
  /** View-once v2 wrapper (newer Baileys versions). */
  readonly viewOnceMessageV2?: { readonly message?: WAMessageContent | null } | null;
}

export interface WAMediaMessage {
  readonly url?: string | null;
  readonly mimetype?: string | null;
  readonly caption?: string | null;
  readonly fileName?: string | null;
}

export interface WADocumentMessage extends WAMediaMessage {
  readonly title?: string | null;
}

export interface WAAudioMessage {
  readonly url?: string | null;
  readonly mimetype?: string | null;
  readonly ptt?: boolean | null;
}

export interface WAStickerMessage {
  readonly url?: string | null;
  readonly mimetype?: string | null;
  readonly isAnimated?: boolean | null;
}

export interface WAReactionMessage {
  readonly text?: string | null;
  readonly key?: {
    readonly remoteJid?: string | null;
    readonly id?: string | null;
  } | null;
}

/** Tagged union of WhatsApp events we handle. */
export type WhatsAppEvent =
  | { readonly kind: "message"; readonly message: WAMessage; readonly chatJid: string }
  | {
      readonly kind: "reaction";
      readonly message: WAMessage;
      readonly chatJid: string;
      readonly reaction: WAReactionMessage;
    };

/**
 * Creates a normalizer for WhatsApp events.
 * Filters out bot's own messages and system messages.
 */
export function createNormalizer(ownJid: string): (event: WhatsAppEvent) => InboundMessage | null {
  return (event: WhatsAppEvent): InboundMessage | null => {
    switch (event.kind) {
      case "message":
        return normalizeMessage(event.message, event.chatJid, ownJid);
      case "reaction":
        return normalizeReaction(event.message, event.chatJid, event.reaction, ownJid);
    }
  };
}

function normalizeMessage(msg: WAMessage, chatJid: string, ownJid: string): InboundMessage | null {
  // Skip own messages
  if (msg.key.fromMe === true) {
    return null;
  }

  // Skip status broadcasts
  if (chatJid === "status@broadcast") {
    return null;
  }

  const rawContent = msg.message;
  if (rawContent === undefined || rawContent === null) {
    return null;
  }

  // Unwrap ephemeral / view-once wrappers before extracting content
  const content = unwrapMessage(rawContent);

  const blocks = extractBlocks(content);
  if (blocks.length === 0) {
    return null;
  }

  const senderId = resolveSenderId(msg, chatJid, ownJid);
  const timestamp = resolveTimestamp(msg.messageTimestamp);

  return {
    content: blocks,
    senderId,
    threadId: chatJid,
    timestamp,
  };
}

function normalizeReaction(
  msg: WAMessage,
  chatJid: string,
  reaction: WAReactionMessage,
  ownJid: string,
): InboundMessage | null {
  if (msg.key.fromMe === true) {
    return null;
  }

  const senderId = resolveSenderId(msg, chatJid, ownJid);

  return {
    content: [
      custom("whatsapp:reaction", {
        emoji: reaction.text ?? "",
        targetMessageId: reaction.key?.id ?? null,
      }),
    ],
    senderId,
    threadId: chatJid,
    timestamp: resolveTimestamp(msg.messageTimestamp),
  };
}

/**
 * Unwraps ephemeral, viewOnce, and viewOnceV2 message wrappers.
 * WhatsApp wraps disappearing and view-once messages in an outer envelope;
 * the actual content is in the nested `.message` field.
 */
function unwrapMessage(content: WAMessageContent): WAMessageContent {
  if (
    content.ephemeralMessage?.message !== undefined &&
    content.ephemeralMessage.message !== null
  ) {
    return unwrapMessage(content.ephemeralMessage.message);
  }
  if (content.viewOnceMessage?.message !== undefined && content.viewOnceMessage.message !== null) {
    return unwrapMessage(content.viewOnceMessage.message);
  }
  if (
    content.viewOnceMessageV2?.message !== undefined &&
    content.viewOnceMessageV2.message !== null
  ) {
    return unwrapMessage(content.viewOnceMessageV2.message);
  }
  return content;
}

function extractBlocks(content: WAMessageContent): readonly ContentBlock[] {
  const blocks: ContentBlock[] = [];

  // Text
  const textContent = content.conversation ?? content.extendedTextMessage?.text;
  if (textContent !== undefined && textContent !== null && textContent.length > 0) {
    blocks.push(text(textContent));
  }

  // Image
  if (content.imageMessage !== null && content.imageMessage !== undefined) {
    const img = content.imageMessage;
    if (img.url !== null && img.url !== undefined) {
      blocks.push(image(img.url, img.caption ?? undefined));
    }
  }

  // Document
  if (content.documentMessage !== null && content.documentMessage !== undefined) {
    const doc = content.documentMessage;
    if (doc.url !== null && doc.url !== undefined) {
      blocks.push(
        file(
          doc.url,
          doc.mimetype ?? "application/octet-stream",
          doc.title ?? doc.fileName ?? undefined,
        ),
      );
    }
  }

  // Audio / Voice note
  if (content.audioMessage !== null && content.audioMessage !== undefined) {
    const audio = content.audioMessage;
    if (audio.url !== null && audio.url !== undefined) {
      const mimeType =
        audio.ptt === true ? "audio/ogg; codecs=opus" : (audio.mimetype ?? "audio/mpeg");
      blocks.push(file(audio.url, mimeType));
    }
  }

  // Video
  if (content.videoMessage !== null && content.videoMessage !== undefined) {
    const vid = content.videoMessage;
    if (vid.url !== null && vid.url !== undefined) {
      blocks.push(file(vid.url, vid.mimetype ?? "video/mp4"));
    }
  }

  // Sticker
  if (content.stickerMessage !== null && content.stickerMessage !== undefined) {
    const sticker = content.stickerMessage;
    blocks.push(
      custom("whatsapp:sticker", {
        url: sticker.url ?? null,
        isAnimated: sticker.isAnimated ?? false,
      }),
    );
  }

  return blocks;
}

function resolveSenderId(msg: WAMessage, chatJid: string, _ownJid: string): string {
  // In groups, use participant JID; in DMs use remoteJid
  if (chatJid.endsWith("@g.us")) {
    return msg.key.participant ?? chatJid;
  }
  return msg.key.remoteJid ?? chatJid;
}

function resolveTimestamp(ts: number | bigint | null | undefined): number {
  if (ts === null || ts === undefined) {
    return Date.now();
  }
  const num = typeof ts === "bigint" ? Number(ts) : ts;
  // Baileys timestamps are in seconds
  return num > 1_000_000_000_000 ? num : num * 1000;
}
