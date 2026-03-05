/**
 * Sends OutboundMessage via signal-cli JSON-RPC commands.
 */

import { splitText } from "@koi/channel-base";
import type { OutboundMessage } from "@koi/core";
import type { SignalProcess } from "./signal-process.js";

/** Maximum text length per Signal message (OpenClaw uses 4000). */
const SIGNAL_TEXT_LIMIT = 4000;

/**
 * Creates a platform send function that converts OutboundMessage
 * to signal-cli JSON-RPC send commands.
 */
export function createPlatformSend(
  process: SignalProcess,
  account: string,
): (message: OutboundMessage) => Promise<void> {
  return async (message: OutboundMessage): Promise<void> => {
    const recipient = message.threadId;
    if (recipient === undefined) {
      throw new Error(
        "[channel-signal] Cannot send: threadId is required. Echo threadId from InboundMessage.",
      );
    }

    // Merge all text blocks into a single message body
    const textParts: string[] = [];
    for (const block of message.content) {
      switch (block.kind) {
        case "text": {
          textParts.push(block.text);
          break;
        }
        case "image": {
          textParts.push(`[Image: ${block.alt ?? block.url}]`);
          break;
        }
        case "file": {
          textParts.push(`[File: ${block.name ?? block.url}]`);
          break;
        }
        case "button": {
          textParts.push(`[${block.label}]`);
          break;
        }
        case "custom": {
          // Skip custom blocks
          break;
        }
      }
    }

    if (textParts.length === 0) {
      return;
    }

    const body = textParts.join("\n");
    const chunks = splitText(body, SIGNAL_TEXT_LIMIT);

    // Determine if sending to group or individual
    const isGroup = recipient.startsWith("group.");

    for (const chunk of chunks) {
      const params: Record<string, unknown> = isGroup
        ? { message: chunk, groupId: recipient, account }
        : { message: chunk, recipient, account };

      await process.send({ method: "send", params });
    }
  };
}
