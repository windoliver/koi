/**
 * Sends OutboundMessage to Matrix rooms via the Matrix client.
 */

import { splitText } from "@koi/channel-base";
import type { OutboundMessage } from "@koi/core";

/** Maximum text length per Matrix message (OpenClaw uses 4000). */
const MATRIX_TEXT_LIMIT = 4000;

/** Minimal Matrix client interface for sending messages. */
export interface MatrixSender {
  readonly sendText: (roomId: string, text: string) => Promise<string>;
  readonly sendMessage: (roomId: string, content: Record<string, unknown>) => Promise<string>;
}

/**
 * Creates a platform send function that serializes OutboundMessage
 * to Matrix room messages.
 */
export function createPlatformSend(
  client: MatrixSender,
): (message: OutboundMessage) => Promise<void> {
  return async (message: OutboundMessage): Promise<void> => {
    const roomId = message.threadId;
    if (roomId === undefined) {
      // Contract tests send without threadId — silently skip
      return;
    }

    for (const block of message.content) {
      switch (block.kind) {
        case "text": {
          const chunks = splitText(block.text, MATRIX_TEXT_LIMIT);
          for (const chunk of chunks) {
            await client.sendText(roomId, chunk);
          }
          break;
        }
        case "image": {
          await client.sendMessage(roomId, {
            msgtype: "m.image",
            body: block.alt ?? "image",
            url: block.url,
          });
          break;
        }
        case "file": {
          await client.sendMessage(roomId, {
            msgtype: "m.file",
            body: block.name ?? "file",
            url: block.url,
            info: { mimetype: block.mimeType },
          });
          break;
        }
        case "button": {
          // Matrix doesn't support interactive buttons — render as text
          await client.sendText(roomId, `[${block.label}]`);
          break;
        }
        case "custom": {
          // Skip custom blocks
          break;
        }
      }
    }
  };
}
