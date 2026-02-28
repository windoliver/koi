/**
 * Slack message event → InboundMessage normalizer.
 *
 * Handles text messages, file uploads, and bot self-filtering.
 */

import { file, image, text } from "@koi/channel-base";
import type { ContentBlock, InboundMessage } from "@koi/core";
import type { SlackFileObject, SlackMessageEvent } from "./normalize.js";

/**
 * Normalizes a Slack message event into an InboundMessage.
 * Returns null for bot's own messages, message_changed subtypes, etc.
 */
export function normalizeMessage(
  event: SlackMessageEvent,
  botUserId: string,
): InboundMessage | null {
  // Skip bot's own messages
  if (event.user === botUserId) {
    return null;
  }

  // Skip message subtypes that aren't user-authored content
  if (
    event.subtype !== undefined &&
    event.subtype !== "file_share" &&
    event.subtype !== "thread_broadcast"
  ) {
    return null;
  }

  const blocks: ContentBlock[] = [];

  // Text content
  if (event.text !== undefined && event.text.length > 0) {
    blocks.push(text(event.text));
  }

  // File attachments
  if (event.files !== undefined) {
    for (const f of event.files) {
      const block = normalizeFile(f);
      if (block !== null) {
        blocks.push(block);
      }
    }
  }

  if (blocks.length === 0) {
    return null;
  }

  // threadId: "channel" or "channel:thread_ts"
  const threadId = resolveThreadId(event.channel, event.thread_ts);

  return {
    content: blocks,
    senderId: event.user ?? "unknown",
    threadId,
    timestamp: Math.floor(Number(event.ts) * 1000),
  };
}

function normalizeFile(f: SlackFileObject): ContentBlock | null {
  const url = f.url_private;
  if (url === undefined) {
    return null;
  }

  const mimeType = f.mimetype ?? "application/octet-stream";
  if (mimeType.startsWith("image/")) {
    return image(url, f.name);
  }

  return file(url, mimeType, f.name);
}

/** Resolves threadId from channel + optional thread_ts. */
export function resolveThreadId(channel: string, threadTs?: string): string {
  if (threadTs !== undefined) {
    return `${channel}:${threadTs}`;
  }
  return channel;
}
