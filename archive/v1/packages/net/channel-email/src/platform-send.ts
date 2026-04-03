/**
 * Email outbound message sender.
 *
 * Converts OutboundMessage → SMTP email via Nodemailer.
 * Handles text, HTML formatting, attachments, and threading headers.
 */

import type { ContentBlock, OutboundMessage } from "@koi/core";
import { mapTextToHtml } from "./format.js";
import { createReplyHeaders, extractDomain, generateMessageId } from "./threading.js";

/** Minimal interface for Nodemailer transporter. */
export interface EmailTransporter {
  readonly sendMail: (options: Record<string, unknown>) => Promise<unknown>;
}

/** Thread context for reply emails. */
export interface ReplyContext {
  readonly originalMessageId: string;
  readonly originalReferences?: string | readonly string[];
  readonly toAddress: string;
  readonly subject?: string;
}

/**
 * Sends an OutboundMessage as an email.
 *
 * @param transporter - Nodemailer transporter instance.
 * @param fromAddress - Sender email address.
 * @param fromName - Optional sender display name.
 * @param message - The outbound message to send.
 * @param replyContext - Optional reply threading context.
 */
export async function emailSend(
  transporter: EmailTransporter,
  fromAddress: string,
  fromName: string | undefined,
  message: OutboundMessage,
  replyContext?: ReplyContext,
): Promise<void> {
  if (replyContext === undefined) {
    return;
  }

  const { textContent, attachments } = buildEmailContent(message.content);
  if (textContent.length === 0 && attachments.length === 0) {
    return;
  }

  const domain = extractDomain(fromAddress);
  const messageId = generateMessageId(domain);

  const from = fromName !== undefined ? `"${fromName}" <${fromAddress}>` : fromAddress;
  const subject =
    replyContext.subject !== undefined ? `Re: ${replyContext.subject}` : "Re: (no subject)";

  const headers: Record<string, string> =
    replyContext.originalMessageId.length > 0
      ? (() => {
          const replyHeaders = createReplyHeaders(
            replyContext.originalMessageId,
            replyContext.originalReferences,
          );
          return {
            "In-Reply-To": replyHeaders.inReplyTo,
            References: replyHeaders.references,
          };
        })()
      : {};

  await transporter.sendMail({
    from,
    to: replyContext.toAddress,
    subject,
    text: textContent,
    html: mapTextToHtml(textContent),
    messageId,
    headers,
    ...(attachments.length > 0 ? { attachments } : {}),
  });
}

interface EmailContent {
  readonly textContent: string;
  readonly attachments: readonly Record<string, unknown>[];
}

function buildEmailContent(blocks: readonly ContentBlock[]): EmailContent {
  // let justified: accumulate text and attachments
  let textContent = "";
  const attachments: Record<string, unknown>[] = [];

  for (const block of blocks) {
    switch (block.kind) {
      case "text":
        textContent = textContent.length > 0 ? `${textContent}\n${block.text}` : block.text;
        break;
      case "image":
        attachments.push({
          filename: block.alt ?? "image",
          path: block.url,
        });
        break;
      case "file":
        attachments.push({
          filename: block.name ?? "file",
          path: block.url,
          contentType: block.mimeType,
        });
        break;
      case "button":
        // Render button as a text link
        textContent =
          textContent.length > 0 ? `${textContent}\n[${block.label}]` : `[${block.label}]`;
        break;
      case "custom":
        // Skip custom blocks
        break;
    }
  }

  return { textContent, attachments };
}
