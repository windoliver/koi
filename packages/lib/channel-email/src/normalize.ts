/**
 * @koi/channel-email — MIME → InboundMessage normalizer.
 *
 * Pure mapping from a parsed MIME message + IMAP UID metadata to a
 * Koi `InboundMessage`. No network, no I/O. Vendor types (mailparser)
 * are kept out via a minimal local `ParsedMail` shape so the channel
 * does not leak `mailparser` types into `@koi/core`.
 */

import type { InboundMessage, JsonObject, TextBlock } from "@koi/core";
import { extractThreadKey } from "./threading.js";

export type ParsedMail = {
  readonly messageId?: string | undefined;
  readonly from?: { readonly value: readonly { readonly address?: string }[] } | undefined;
  readonly to?: { readonly value: readonly { readonly address?: string }[] } | undefined;
  readonly subject?: string | undefined;
  readonly date?: Date | undefined;
  readonly text?: string | undefined;
  readonly html?: string | false | undefined;
  readonly inReplyTo?: string | undefined;
  readonly references?: string | readonly string[] | undefined;
  readonly attachments?:
    | readonly {
        readonly filename?: string;
        readonly contentType?: string;
        readonly size?: number;
      }[]
    | undefined;
};

export type NormalizeInput = {
  readonly parsed: ParsedMail;
  readonly imap: { readonly uidValidity: number; readonly uid: number };
};

export type NormalizeErrorCode = "PARSE_FAILED" | "UNSUPPORTED_TRANSPORT";

export type NormalizeError = {
  readonly code: NormalizeErrorCode;
  readonly message: string;
};

export type NormalizeResult =
  | { readonly ok: true; readonly value: InboundMessage }
  | { readonly ok: false; readonly error: NormalizeError };

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

function stripHtml(html: string): string {
  const noTags = html.replace(/<[^>]+>/g, "");
  const decoded = noTags.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => HTML_ENTITIES[m] ?? m);
  return decoded.replace(/\s+/g, " ").trim();
}

function normalizeReferences(refs: ParsedMail["references"]): readonly string[] {
  if (Array.isArray(refs)) return [...refs];
  if (typeof refs === "string") return refs.split(/\s+/).filter(Boolean);
  return [];
}

function deriveContent(parsed: ParsedMail): readonly TextBlock[] {
  if (typeof parsed.text === "string" && parsed.text.length > 0) {
    return [{ kind: "text", text: parsed.text }];
  }
  if (typeof parsed.html === "string" && parsed.html.length > 0) {
    return [{ kind: "text", text: stripHtml(parsed.html) }];
  }
  return [{ kind: "text", text: "" }];
}

export function normalizeEmail(
  input: NormalizeInput,
  clock: () => number = Date.now,
): NormalizeResult {
  const { parsed, imap } = input;

  const messageId = parsed.messageId;
  if (typeof messageId !== "string" || messageId.length === 0) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_TRANSPORT",
        message: "no Message-ID header (POP3 not supported)",
      },
    };
  }

  const fromAddress = parsed.from?.value[0]?.address;
  if (typeof fromAddress !== "string" || fromAddress.length === 0) {
    return {
      ok: false,
      error: { code: "PARSE_FAILED", message: "missing From header" },
    };
  }

  const senderId = fromAddress.toLowerCase();

  const ts = parsed.date?.getTime();
  const timestamp = typeof ts === "number" && Number.isFinite(ts) ? ts : clock();

  const references = normalizeReferences(parsed.references);
  const threadId = extractThreadKey({
    messageId,
    ...(typeof parsed.inReplyTo === "string" ? { inReplyTo: parsed.inReplyTo } : {}),
    references,
  });

  const metadata: JsonObject = {
    uidValidity: imap.uidValidity,
    uid: imap.uid,
    messageId,
    ...(typeof parsed.subject === "string" ? { subject: parsed.subject } : {}),
    ...(parsed.attachments && parsed.attachments.length > 0
      ? {
          attachments: parsed.attachments.map((a) => ({
            ...(typeof a.filename === "string" ? { filename: a.filename } : {}),
            ...(typeof a.contentType === "string" ? { contentType: a.contentType } : {}),
            ...(typeof a.size === "number" ? { size: a.size } : {}),
          })),
        }
      : {}),
  };

  const value: InboundMessage = {
    content: deriveContent(parsed),
    senderId,
    threadId,
    timestamp,
    metadata,
  };

  return { ok: true, value };
}
