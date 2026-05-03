import type { InboundMessage } from "@koi/core";

/** Concatenate all text-block content from a message. Returns "" if none. */
export function extractText(message: InboundMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.kind === "text") parts.push(block.text);
  }
  return parts.join(" ").trim();
}

/** Extract text from the LAST user-authored message in a turn. */
export function extractLastUserText(messages: readonly InboundMessage[]): string {
  return extractLastUserMessage(messages)?.text ?? "";
}

/**
 * Locate the last user-authored message in a turn AND its extracted
 * text in one pass. Callers can fingerprint the message identity to
 * detect engine-driven re-runs of the same turn (stop-gate retries)
 * where `extractLastUserText` alone would return identical text on
 * every pass (review round 14, finding 1).
 */
export function extractLastUserMessage(
  messages: readonly InboundMessage[],
): { readonly message: InboundMessage; readonly text: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.senderId !== "user") continue;
    const text = extractText(m);
    if (text.length > 0) return { message: m, text };
  }
  return undefined;
}
