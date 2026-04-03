/**
 * Normalizes Matrix room events to InboundMessage.
 *
 * Handles m.text, m.image, m.file message types.
 * Returns null for unsupported event types and bot self-messages.
 */

import type { MessageNormalizer } from "@koi/channel-base";
import { file, image, text } from "@koi/channel-base";
import type { ContentBlock, InboundMessage } from "@koi/core";

/** Minimal Matrix room event shape used for normalization. */
export interface MatrixRoomEvent {
  readonly type: string;
  readonly sender: string;
  readonly event_id: string;
  readonly room_id: string;
  readonly content: {
    readonly msgtype?: string;
    readonly body?: string;
    readonly url?: string;
    readonly info?: {
      readonly mimetype?: string;
    };
  };
}

/**
 * Creates a normalizer that converts Matrix room events to InboundMessage.
 * Filters out events from the bot itself (identified by userId).
 */
export function createNormalizer(botUserId: string): MessageNormalizer<MatrixRoomEvent> {
  return (event: MatrixRoomEvent): InboundMessage | null => {
    // Ignore own messages
    if (event.sender === botUserId) {
      return null;
    }

    // Only handle m.room.message events
    if (event.type !== "m.room.message") {
      return null;
    }

    const msgtype = event.content.msgtype;
    const body = event.content.body ?? "";

    const blocks: ContentBlock[] = [];

    if (msgtype === "m.text" || msgtype === "m.notice") {
      if (body.length === 0) {
        return null;
      }
      blocks.push(text(body));
    } else if (msgtype === "m.image") {
      const url = event.content.url ?? "";
      if (url.length > 0) {
        blocks.push(image(url, body.length > 0 ? body : undefined));
      } else {
        return null;
      }
    } else if (msgtype === "m.file") {
      const url = event.content.url ?? "";
      const mimeType = event.content.info?.mimetype ?? "application/octet-stream";
      if (url.length > 0) {
        blocks.push(file(url, mimeType, body.length > 0 ? body : undefined));
      } else {
        return null;
      }
    } else {
      // Unsupported message type
      return null;
    }

    if (blocks.length === 0) {
      return null;
    }

    return {
      content: blocks,
      senderId: event.sender,
      threadId: event.room_id,
      timestamp: Date.now(),
    };
  };
}
