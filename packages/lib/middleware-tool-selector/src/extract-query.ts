/**
 * Default query extraction — pulls text from the last inbound message.
 *
 * Used by `createToolSelectorMiddleware` to derive a query string from the
 * conversation transcript before invoking the caller's `selectTools` strategy.
 */

import type { InboundMessage } from "@koi/core";

/**
 * Walks the transcript backward and returns the concatenated text of the most
 * recent user-authored message. Matches the platform-wide convention that
 * user messages may have `senderId` of `"user"`, the multi-user
 * `"user-<n>"` form (e.g. `"user-1"`), or a channel-prefixed form like
 * `"cli-user"` / `"web-user"` (see channel-cli, channel-web). Skips
 * assistant replies, tool results, and `system:*` entries so selection is
 * keyed on user intent — not stale assistant/tool output that happens to
 * sit at the tail. Returns "" when no user message has any text block
 * (caller treats empty as "skip filtering"). #review-round15-F2.
 */
export function extractLastUserText(messages: readonly InboundMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === undefined || !isUserSender(msg.senderId)) continue;

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

function isUserSender(senderId: string): boolean {
  if (senderId === "assistant" || senderId === "tool") return false;
  if (senderId.startsWith("system:")) return false;
  return (
    senderId === "user" ||
    senderId.startsWith("user-") ||
    senderId.endsWith("-user") ||
    senderId.includes("-user-")
  );
}
