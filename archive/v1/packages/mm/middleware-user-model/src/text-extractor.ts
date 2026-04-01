/**
 * Utility to extract text from InboundMessage arrays.
 */

import type { InboundMessage } from "@koi/core/message";

/**
 * Extracts text from the last message's text content blocks.
 * Scans backwards from the last message, returning the first text block found.
 */
export function extractLastMessageText(messages: readonly InboundMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg) {
      for (const block of msg.content) {
        if (block.kind === "text") {
          return block.text;
        }
      }
    }
  }
  return "";
}
