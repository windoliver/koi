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

// Strict allowlist for documented user-sender shapes only — substring
// matching let assistant/tool/bridge entries with user-like IDs spoof
// transcript provenance and steer tool selection (#review-round16-F2).
// Forms accepted (with the channel prefix drawn from the explicit
// KNOWN_CHANNEL_PREFIXES set below):
//   - "user"                         (canonical)
//   - "user-<digits>"                (multi-user / resumed transcripts)
//   - "<known-channel>-user"         (e.g. "cli-user", "web-user")
//   - "<known-channel>-user-<digits>"
// New channel prefixes must be added to KNOWN_CHANNEL_PREFIXES as
// channels ship — broadening this with a wildcard like /[a-z]+-user/
// is a trust-boundary regression because senders such as
// "assistant-user" / "tool-user" would slip through.
// Only includes channel prefixes actually shipped by bundled @koi/channel-*
// packages. Add entries here as new channels land — never broaden to a
// wildcard prefix.
const KNOWN_CHANNEL_PREFIXES: readonly string[] = ["cli"];
const USER_SENDER_RE = new RegExp(
  `^(?:user(?:-\\d+)?|(?:${KNOWN_CHANNEL_PREFIXES.join("|")})-user(?:-\\d+)?)$`,
);

function isUserSender(senderId: string): boolean {
  return USER_SENDER_RE.test(senderId);
}
