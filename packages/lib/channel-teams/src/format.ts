/**
 * @koi/channel-teams — OutboundMessage → Bot Framework activity payload.
 *
 * v1 keeps this minimal: text blocks become a `type: "message"` payload with
 * `text` joined by blank lines. Non-text blocks are silently dropped.
 */

import type { OutboundMessage } from "@koi/core";

export type ActivityPayload = {
  readonly type: "message";
  readonly text: string;
};

export function formatOutbound(message: OutboundMessage): ActivityPayload {
  const texts: readonly string[] = message.content.flatMap((b) =>
    b.kind === "text" ? [b.text] : [],
  );
  return { type: "message", text: texts.join("\n\n") };
}
