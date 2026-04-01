/**
 * Default query extraction — extracts text from the last inbound message.
 */

import type { InboundMessage } from "@koi/core";

/**
 * Extracts text content from the last message in the list.
 * Returns empty string if no messages or no text blocks found.
 */
export function extractLastUserText(messages: readonly InboundMessage[]): string {
  const lastMessage = messages[messages.length - 1];
  if (lastMessage === undefined) {
    return "";
  }

  return lastMessage.content
    .filter(
      (block): block is Extract<typeof block, { readonly kind: "text" }> => block.kind === "text",
    )
    .map((block) => block.text)
    .join(" ");
}
