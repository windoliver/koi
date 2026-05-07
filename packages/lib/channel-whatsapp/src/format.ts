/**
 * @koi/channel-whatsapp — OutboundMessage → Cloud API messages payload.
 *
 * v1 supports text only. Multiple text blocks are joined by blank lines and
 * `preview_url: false` is always set to avoid surprise link unfurls. When
 * `contextMessageId` is supplied, the resulting payload threads as a reply
 * via Meta's `context.message_id` field.
 *
 * Non-text blocks (image/file/buttons/audio/video) fail closed with
 * `UNSUPPORTED_BLOCK` until the Cloud API media + interactive serializers
 * are wired in. Silently dropping them is silent data loss — `send()`
 * resolves while the recipient sees a partial or empty WhatsApp message
 * with no operator signal. Capability flags advertise text-only, so any
 * caller passing a non-text block is bypassing the capability check or
 * holding stale data — both warrant a hard failure.
 */

import type { OutboundMessage } from "@koi/core";

export type WhatsAppOutboundPayload = {
  readonly messaging_product: "whatsapp";
  readonly recipient_type: "individual";
  readonly to: string;
  readonly type: "text";
  readonly text: { readonly body: string; readonly preview_url: false };
  readonly context?: { readonly message_id: string };
};

export type FormatOutboundOptions = {
  readonly message: OutboundMessage;
  readonly recipient: string;
  readonly contextMessageId?: string;
};

export type FormatError = {
  readonly code: "UNSUPPORTED_BLOCK";
  readonly message: string;
  readonly context: { readonly kind: string };
};

export type FormatResult =
  | { readonly ok: true; readonly value: WhatsAppOutboundPayload }
  | { readonly ok: false; readonly error: FormatError };

export function formatOutbound(opts: FormatOutboundOptions): FormatResult {
  const texts: string[] = [];
  for (const b of opts.message.content) {
    if (b.kind === "text") {
      texts.push(b.text);
      continue;
    }
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_BLOCK",
        message: `WhatsApp outbound does not support content block "${b.kind}" (only "text" is wired). Capability flags advertise text-only — sender should check capabilities.images/files/buttons before including non-text blocks.`,
        context: { kind: b.kind },
      },
    };
  }
  const body = texts.join("\n\n");
  return {
    ok: true,
    value: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: opts.recipient,
      type: "text",
      text: { body, preview_url: false },
      ...(opts.contextMessageId !== undefined
        ? { context: { message_id: opts.contextMessageId } }
        : {}),
    },
  };
}
