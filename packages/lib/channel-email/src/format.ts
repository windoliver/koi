/**
 * @koi/channel-email — outbound message formatting.
 *
 * Pure function that converts an `OutboundMessage` plus `ThreadState` plus a
 * pre-generated `Message-ID` into an SMTP envelope ready for delivery.
 *
 * Non-text content blocks (file/image/button/custom) are dropped from the
 * body for v1 — plain SMTP cannot represent them. Attachment support is
 * deferred to a future iteration.
 */

import type { ThreadState } from "@koi/channel-base";
import type { OutboundMessage } from "@koi/core";
import { deriveReplyHeaders } from "./threading.js";

export type SmtpEnvelope = {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly headers: Readonly<Record<string, string>>;
};

export function formatOutbound(input: {
  readonly message: OutboundMessage;
  readonly thread: ThreadState;
  readonly outboundMessageId: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
}): SmtpEnvelope {
  const { message, thread, outboundMessageId, from, to, subject } = input;

  const text = message.content
    .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
    .map((b) => b.text)
    .join("\n\n");

  const html = typeof message.metadata?.html === "string" ? message.metadata.html : undefined;

  const headers: Readonly<Record<string, string>> = {
    "Message-ID": outboundMessageId,
    ...deriveReplyHeaders(thread),
  };

  return {
    from,
    to,
    subject,
    text,
    ...(html !== undefined ? { html } : {}),
    headers,
  };
}
