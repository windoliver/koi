/**
 * Sends OutboundMessage as WebSocket frames to connected clients.
 */

import { splitText } from "@koi/channel-base";
import type { ContentBlock, OutboundMessage } from "@koi/core";
import type { MobileOutboundFrame } from "./protocol.js";

/** Maximum text length per mobile WebSocket frame (generous for native apps). */
const MOBILE_TEXT_LIMIT = 8000;

/** WebSocket-like interface for sending data. */
export interface WebSocketSender {
  readonly send: (data: string) => void;
}

/**
 * Serializes an OutboundMessage into a MobileOutboundFrame and sends it
 * to the appropriate WebSocket client(s).
 */
export function createPlatformSend(
  getClients: () => ReadonlyMap<string, WebSocketSender>,
): (message: OutboundMessage) => Promise<void> {
  return async (message: OutboundMessage): Promise<void> => {
    // Split oversized text blocks into chunks
    const expandedContent: ContentBlock[] = [];
    for (const block of message.content) {
      if (block.kind === "text" && block.text.length > MOBILE_TEXT_LIMIT) {
        const chunks = splitText(block.text, MOBILE_TEXT_LIMIT);
        for (const chunk of chunks) {
          expandedContent.push({ kind: "text", text: chunk });
        }
      } else {
        expandedContent.push(block);
      }
    }

    const frame: MobileOutboundFrame = {
      kind: "message",
      content: expandedContent,
    };
    const payload = JSON.stringify(frame);

    const clients = getClients();

    if (message.threadId !== undefined) {
      // Send to specific client by threadId ("mobile:<clientId>")
      const clientId = message.threadId.startsWith("mobile:")
        ? message.threadId.slice(7)
        : message.threadId;
      const ws = clients.get(clientId);
      if (ws !== undefined) {
        ws.send(payload);
      }
      return;
    }

    // Broadcast to all connected clients
    for (const ws of clients.values()) {
      ws.send(payload);
    }
  };
}
