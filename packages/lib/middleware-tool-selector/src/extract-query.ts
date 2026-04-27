/**
 * Default query extraction — pulls text from the last inbound message.
 *
 * Used by `createToolSelectorMiddleware` to derive a query string from the
 * conversation transcript before invoking the caller's `selectTools` strategy.
 */

import type { InboundMessage } from "@koi/core";

/**
 * Walks the transcript backward and returns the concatenated text of the most
 * recent user-authored message. Recognized sender IDs are:
 *   - `"user"`              — canonical
 *   - `"user-<digits>"`     — multi-user / resumed transcripts (e.g. "user-1")
 *   - `"<channel>-user"`    — channel-prefixed (only currently shipped:
 *                              `"cli-user"` from `@koi/channel-cli`)
 *   - `"<channel>-user-<digits>"`
 *
 * Skips assistant replies, tool results, and `system:*` entries so selection
 * is keyed on user intent — not stale assistant/tool output that happens to
 * sit at the tail. Returns "" when no user message has any text block
 * (caller treats empty as "skip filtering").
 *
 * Channel prefixes are an explicit allowlist (KNOWN_CHANNEL_PREFIXES). New
 * channels must be added there — broadening to a wildcard prefix would let
 * non-user transcript producers (assistant-user, tool-user-1, etc.) spoof
 * latest-user-message provenance and steer tool selection.
 * #review-round15-F2 / #review-round16-F2 / #review-round17-F2.
 */
export function extractLastUserText(
  messages: readonly InboundMessage[],
  isUser: (senderId: string) => boolean = isUserSender,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === undefined || !isUser(msg.senderId)) continue;

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
