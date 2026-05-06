/**
 * @koi/channel-whatsapp — Meta Cloud `messages` entry → InboundMessage normalizer.
 *
 * Each Meta webhook delivery may carry multiple `messages[]` entries; this
 * function operates on a single entry. The caller is responsible for
 * iterating multi-message webhooks (see whatsapp-channel.ts).
 *
 * Inbound media is referenced by Meta's media-id; we surface it as
 * `<media:${id}>` so a downstream resolver can swap it for a signed URL
 * after a separate Graph API media-fetch call.
 */

import type { ContentBlock, InboundMessage, JsonObject } from "@koi/core";

export type WhatsAppMessage = {
  readonly id: string;
  readonly from: string;
  readonly timestamp: string;
  readonly type: string;
  readonly text?: { readonly body: string };
  readonly image?: {
    readonly id: string;
    readonly mime_type: string;
    readonly caption?: string;
  };
  readonly document?: {
    readonly id: string;
    readonly mime_type: string;
    readonly filename?: string;
  };
  readonly audio?: { readonly id: string; readonly mime_type: string };
  readonly context?: { readonly message_id?: string };
};

export type WhatsAppWebhookEntry = {
  readonly object: "whatsapp_business_account";
  readonly entry: readonly {
    readonly id: string;
    readonly changes: readonly {
      readonly value: {
        readonly metadata: { readonly phone_number_id: string };
        readonly messages?: readonly WhatsAppMessage[];
        readonly statuses?: unknown;
      };
      readonly field: "messages";
    }[];
  }[];
};

export type NormalizeError = { readonly code: "INVALID_PAYLOAD"; readonly message: string };

export type NormalizeResult =
  | { readonly ok: true; readonly value: InboundMessage }
  | { readonly ok: false; readonly error: NormalizeError };

function buildContent(message: WhatsAppMessage): readonly ContentBlock[] {
  if (message.text !== undefined) {
    return [{ kind: "text", text: message.text.body }];
  }
  if (message.image !== undefined) {
    const blocks: ContentBlock[] = [{ kind: "image", url: `<media:${message.image.id}>` }];
    const caption = message.image.caption;
    if (typeof caption === "string" && caption.length > 0) {
      blocks.push({ kind: "text", text: caption });
    }
    return blocks;
  }
  if (message.document !== undefined) {
    const doc = message.document;
    return [
      {
        kind: "file",
        url: `<media:${doc.id}>`,
        mimeType: doc.mime_type,
        ...(doc.filename !== undefined ? { name: doc.filename } : {}),
      },
    ];
  }
  if (message.audio !== undefined) {
    return [
      { kind: "file", url: `<media:${message.audio.id}>`, mimeType: message.audio.mime_type },
    ];
  }
  return [{ kind: "custom", type: `whatsapp/${message.type}`, data: message }];
}

export function normalizeWhatsApp(
  message: WhatsAppMessage,
  phoneNumberId: string,
  clock: () => number = Date.now,
): NormalizeResult {
  if (typeof message.from !== "string" || message.from.length === 0) {
    return { ok: false, error: { code: "INVALID_PAYLOAD", message: "missing from" } };
  }
  if (typeof message.id !== "string" || message.id.length === 0) {
    return { ok: false, error: { code: "INVALID_PAYLOAD", message: "missing id" } };
  }

  const tsSeconds = Number.parseInt(message.timestamp ?? "", 10);
  const timestamp = Number.isFinite(tsSeconds) && tsSeconds > 0 ? tsSeconds * 1000 : clock();

  const meta: JsonObject = {
    wamid: message.id,
    phoneNumberId,
    ...(message.context?.message_id !== undefined
      ? { contextMessageId: message.context.message_id }
      : {}),
  };

  const inbound: InboundMessage = {
    content: buildContent(message),
    senderId: message.from,
    // Composite threadId scopes the conversation by business number so
    // a multi-number deployment cannot merge two distinct conversations
    // that share the same end-user phone. The raw recipient phone is
    // preserved in metadata.recipientPhone for outbound routing.
    threadId: `${phoneNumberId}|${message.from}`,
    timestamp,
    metadata: { ...meta, recipientPhone: message.from },
  };
  return { ok: true, value: inbound };
}
