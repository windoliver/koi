/**
 * Default query extraction — pulls text from the last inbound message.
 *
 * Used by `createToolSelectorMiddleware` to derive a query string from the
 * conversation transcript before invoking the caller's `selectTools` strategy.
 */

import type { InboundMessage } from "@koi/core";

/**
 * Extracts text content from the last message in the list.
 * Concatenates all `text` content blocks of the final message with single
 * spaces. Returns an empty string when no messages exist or no text blocks
 * are present (caller treats empty as "skip filtering").
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
