/**
 * Email message normalizer.
 *
 * Converts parsed email messages into InboundMessage objects.
 * Handles text/plain, text/html, attachments, and threading headers.
 */

import { custom, file, image, text } from "@koi/channel-base";
import type { ContentBlock, InboundMessage } from "@koi/core";

/** Parsed email message shape (from mailparser). */
export interface ParsedEmail {
  readonly messageId?: string;
  readonly from?: { readonly value?: readonly EmailAddress[] };
  readonly to?: { readonly value?: readonly EmailAddress[] };
  readonly subject?: string;
  readonly text?: string;
  readonly html?: string | false;
  readonly date?: Date;
  readonly inReplyTo?: string;
  readonly references?: string | readonly string[];
  readonly attachments?: readonly EmailAttachment[];
  readonly headerLines?: readonly { readonly key: string; readonly line: string }[];
}

export interface EmailAddress {
  readonly address?: string;
  readonly name?: string;
}

export interface EmailAttachment {
  readonly filename?: string;
  readonly contentType?: string;
  readonly content?: Buffer;
  readonly size?: number;
  readonly contentDisposition?: string;
  readonly cid?: string;
}

/** Tagged event for the email channel. */
export interface EmailEvent {
  readonly kind: "email";
  readonly email: ParsedEmail;
  readonly uid: number;
}

/**
 * Normalizes a parsed email into an InboundMessage.
 * Returns null for emails that cannot be processed.
 */
export function normalizeEmail(event: EmailEvent): InboundMessage | null {
  const email = event.email;

  const senderAddress = email.from?.value?.[0]?.address;
  if (senderAddress === undefined) {
    return null;
  }

  const blocks = extractBlocks(email);
  if (blocks.length === 0) {
    return null;
  }

  // Use Message-ID as threadId for threading
  const threadId = email.messageId ?? `uid:${event.uid}`;
  const timestamp = email.date !== undefined ? email.date.getTime() : Date.now();

  return {
    content: blocks,
    senderId: senderAddress,
    threadId,
    timestamp,
    ...(email.subject !== undefined || email.inReplyTo !== undefined
      ? {
          metadata: {
            ...(email.subject !== undefined ? { subject: email.subject } : {}),
            ...(email.inReplyTo !== undefined ? { inReplyTo: email.inReplyTo } : {}),
            ...(email.references !== undefined ? { references: email.references } : {}),
          },
        }
      : {}),
  };
}

function extractBlocks(email: ParsedEmail): readonly ContentBlock[] {
  const blocks: ContentBlock[] = [];

  // Prefer plain text; fall back to indicating HTML is available
  if (email.text !== undefined && email.text.length > 0) {
    blocks.push(text(email.text));
  }

  // Store HTML as custom block if available
  if (email.html !== undefined && email.html !== false && email.html.length > 0) {
    if (blocks.length === 0) {
      // No plain text — add a note
      blocks.push(text("[HTML email — see metadata for full content]"));
    }
    blocks.push(custom("email:html", { html: email.html }));
  }

  // Attachments
  if (email.attachments !== undefined) {
    for (const attachment of email.attachments) {
      const block = normalizeAttachment(attachment);
      if (block !== null) {
        blocks.push(block);
      }
    }
  }

  return blocks;
}

function normalizeAttachment(attachment: EmailAttachment): ContentBlock | null {
  // Skip inline CID attachments (they're referenced in HTML)
  if (attachment.cid !== undefined && attachment.contentDisposition === "inline") {
    return null;
  }

  const mimeType = attachment.contentType ?? "application/octet-stream";
  // We can't provide a URL for email attachments (they're buffers),
  // so we use a data URI or a placeholder
  const url =
    attachment.content !== undefined
      ? `data:${mimeType};base64,${attachment.content.toString("base64")}`
      : "attachment:no-content";

  if (mimeType.startsWith("image/")) {
    return image(url, attachment.filename);
  }

  return file(url, mimeType, attachment.filename);
}
