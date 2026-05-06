/**
 * @koi/channel-email — outbound message formatting.
 *
 * Pure function that converts an `OutboundMessage` plus `ThreadState` plus a
 * pre-generated `Message-ID` into an SMTP envelope ready for delivery.
 *
 * Non-text blocks (image/file/button/custom) fail closed with
 * `UNSUPPORTED_BLOCK` until SMTP attachment / multipart support is wired
 * in. Silently dropping them is silent data loss: the outbox advances to
 * `sent` while the recipient sees a partial mail (or empty body, on
 * all-non-text content) with no operator signal. Capability flags
 * advertise text-only — silent drops mask sender bugs and stale
 * capability data.
 */

import type { ThreadState } from "@koi/channel-base";
import type { OutboundMessage } from "@koi/core";
import type { SmtpEnvelope } from "./platform-send.js";
import { deriveReplyHeaders } from "./threading.js";

export type { SmtpEnvelope } from "./platform-send.js";

export type FormatError = {
  readonly code: "UNSUPPORTED_BLOCK";
  readonly message: string;
  readonly context: { readonly kind: string };
};

export type FormatResult =
  | { readonly ok: true; readonly value: SmtpEnvelope }
  | { readonly ok: false; readonly error: FormatError };

export function formatOutbound(input: {
  readonly message: OutboundMessage;
  readonly thread: ThreadState;
  readonly outboundMessageId: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
}): FormatResult {
  const { message, thread, outboundMessageId, from, to, subject } = input;

  const texts: string[] = [];
  for (const b of message.content) {
    if (b.kind === "text") {
      texts.push(b.text);
      continue;
    }
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_BLOCK",
        message: `Email outbound does not support content block "${b.kind}" (only "text" is wired). Capability flags advertise text-only — sender should check capabilities.images/files/buttons before including non-text blocks.`,
        context: { kind: b.kind },
      },
    };
  }

  const html = typeof message.metadata?.html === "string" ? message.metadata.html : undefined;

  const headers: Readonly<Record<string, string>> = {
    "Message-ID": outboundMessageId,
    ...deriveReplyHeaders(thread),
  };

  return {
    ok: true,
    value: {
      from,
      to,
      subject,
      text: texts.join("\n\n"),
      ...(html !== undefined ? { html } : {}),
      headers,
    },
  };
}
