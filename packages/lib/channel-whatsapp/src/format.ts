/**
 * @koi/channel-whatsapp — OutboundMessage → Cloud API messages payload.
 *
 * v1 supports text only. Multiple text blocks are joined by blank lines and
 * `preview_url: false` is always set to avoid surprise link unfurls. When
 * `contextMessageId` is supplied, the resulting payload threads as a reply
 * via Meta's `context.message_id` field.
 *
 * Non-text blocks are silently dropped from the body — this mirrors the
 * channel-teams convention. Outbound media + interactive payloads are out
 * of scope for v1.
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

export function formatOutbound(opts: FormatOutboundOptions): WhatsAppOutboundPayload {
  const texts = opts.message.content.flatMap((b) => (b.kind === "text" ? [b.text] : []));
  const body = texts.join("\n\n");
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: opts.recipient,
    type: "text",
    text: { body, preview_url: false },
    ...(opts.contextMessageId !== undefined
      ? { context: { message_id: opts.contextMessageId } }
      : {}),
  };
}
