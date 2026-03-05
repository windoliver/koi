/**
 * Extracts concatenated text from an InboundMessage's content blocks.
 */

import type { InboundMessage, TextBlock } from "@koi/core/message";

export function textOf(message: InboundMessage): string {
  return message.content
    .filter((b): b is TextBlock => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
}
