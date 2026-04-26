/**
 * Default query extraction — pulls text from the last inbound message.
 *
 * Used by `createToolSelectorMiddleware` to derive a query string from the
 * conversation transcript before invoking the caller's `selectTools` strategy.
 */

import type { InboundMessage } from "@koi/core";

/**
 * Walks the transcript backward and returns the concatenated text of the most
 * recent message authored by the user (`senderId === "user"`). Skips assistant
 * replies, tool results, and system entries so selection is keyed on user
 * intent — not stale assistant/tool text that happens to be at the tail.
 * Returns "" when no user message has any text block (caller treats empty as
 * "skip filtering").
 */
export function extractLastUserText(messages: readonly InboundMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === undefined || msg.senderId !== "user") continue;

    const text = msg.content
      .filter(
        (block): block is Extract<typeof block, { readonly kind: "text" }> => block.kind === "text",
      )
      .map((block) => block.text)
      .join(" ");

    if (text.length > 0) return text;
  }

  return "";
}
