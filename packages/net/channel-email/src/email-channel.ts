/**
 * @koi/channel-email — IMAP/SMTP email channel adapter.
 *
 * Creates a ChannelAdapter for email using ImapFlow (receive via IDLE)
 * and Nodemailer (send via SMTP).
 *
 * Usage:
 *   const adapter = createEmailChannel({
 *     imap: { host: "imap.gmail.com", port: 993, auth: { user: "...", pass: "..." } },
 *     smtp: { host: "smtp.gmail.com", port: 587, auth: { user: "...", pass: "..." } },
 *     fromAddress: "bot@example.com",
 *   });
 *   await adapter.connect();
 *
 * threadId convention: email Message-ID header value
 */

import { createChannelAdapter, createMediaFallback } from "@koi/channel-base";
import type { ChannelAdapter, ChannelCapabilities, ChannelStatus } from "@koi/core";
import type { EmailChannelConfig } from "./config.js";
import type { EmailEvent, ParsedEmail } from "./normalize.js";
import { normalizeEmail } from "./normalize.js";
import type { EmailTransporter, ReplyContext } from "./platform-send.js";
import { emailSend } from "./platform-send.js";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const EMAIL_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: false,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

// ---------------------------------------------------------------------------
// Extended adapter interface
// ---------------------------------------------------------------------------

/** ChannelAdapter for Email (no additional methods for now). */
export type EmailChannelAdapter = ChannelAdapter;

// ---------------------------------------------------------------------------
// Types for injected or real clients
// ---------------------------------------------------------------------------

interface ImapClientLike {
  readonly connect: () => Promise<void>;
  readonly logout: () => Promise<void>;
  readonly getMailboxLock: (mailbox: string) => Promise<{ readonly release: () => void }>;
  readonly idle: () => Promise<void>;
  readonly fetchOne: (
    seq: string,
    query: Record<string, unknown>,
  ) => Promise<{ readonly source: Buffer }>;
  readonly on: (event: string, handler: (...args: readonly unknown[]) => void) => void;
  readonly removeAllListeners: () => void;
}

interface TransporterLike {
  readonly sendMail: (options: Record<string, unknown>) => Promise<unknown>;
  readonly close: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an Email ChannelAdapter.
 *
 * @param config - IMAP/SMTP settings, sender address, and optional hooks.
 * @returns An EmailChannelAdapter satisfying the @koi/core ChannelAdapter contract.
 */
export function createEmailChannel(config: EmailChannelConfig): EmailChannelAdapter {
  const imapClient = (config._imapClient ?? null) as ImapClientLike | null;
  const transporter = (config._transporter ?? null) as TransporterLike | null;

  // let justified: active IMAP client, created during connect if not injected
  let activeImap: ImapClientLike | null = imapClient;
  let activeTransporter: TransporterLike | null = transporter;
  let mailboxLock: { readonly release: () => void } | null = null;

  // let justified: stores reply context for threading (capped at 1000 entries)
  const replyContexts = new Map<string, ReplyContext>();
  const REPLY_CONTEXT_MAX = 1000;

  const emailTransporter: EmailTransporter = {
    sendMail: async (options: Record<string, unknown>) => {
      if (activeTransporter === null) {
        throw new Error("[channel-email] Cannot send: not connected");
      }
      return activeTransporter.sendMail(options);
    },
  };

  const platformSendStatus = async (_status: ChannelStatus): Promise<void> => {
    // Email doesn't support typing indicators
  };

  return createChannelAdapter<EmailEvent>({
    name: "email",
    capabilities: EMAIL_CAPABILITIES,

    platformConnect: async () => {
      if (activeImap === null) {
        activeImap = createImapClient(config);
      }
      if (activeTransporter === null) {
        activeTransporter = createNodemailerTransporter(config);
      }

      await activeImap.connect();
      const mailbox = config.imap.mailbox ?? "INBOX";
      mailboxLock = await activeImap.getMailboxLock(mailbox);
    },

    platformDisconnect: async () => {
      if (mailboxLock !== null) {
        mailboxLock.release();
        mailboxLock = null;
      }
      if (activeImap !== null) {
        activeImap.removeAllListeners();
        await activeImap.logout();
        activeImap = null;
      }
      if (activeTransporter !== null) {
        activeTransporter.close();
        activeTransporter = null;
      }
    },

    platformSend: createMediaFallback({
      send: async (message) => {
        const threadId = message.threadId;
        const replyContext = threadId !== undefined ? replyContexts.get(threadId) : undefined;
        await emailSend(
          emailTransporter,
          config.fromAddress,
          config.fromName,
          message,
          replyContext,
        );
      },
      ...(config.mediaMaxMb !== undefined ? { mediaMaxMb: config.mediaMaxMb } : {}),
    }),

    onPlatformEvent: (handler) => {
      if (activeImap === null) {
        return () => {};
      }

      const imap = activeImap;

      imap.on("exists", (rawEvent: unknown) => {
        const event = rawEvent as {
          readonly path: string;
          readonly count: number;
          readonly prevCount: number;
        };
        // Fetch the newest message
        void (async () => {
          try {
            const msg = await imap.fetchOne("*", { source: true });
            const parsed = await parseEmail(msg.source);
            if (parsed !== null) {
              const uid = event.count;
              const emailEvent: EmailEvent = { kind: "email", email: parsed, uid };

              // Store reply context for threading (evict oldest if at capacity)
              const senderAddress = parsed.from?.value?.[0]?.address;
              if (parsed.messageId !== undefined && senderAddress !== undefined) {
                if (replyContexts.size >= REPLY_CONTEXT_MAX) {
                  const oldest = replyContexts.keys().next().value;
                  if (oldest !== undefined) {
                    replyContexts.delete(oldest);
                  }
                }
                replyContexts.set(parsed.messageId, {
                  originalMessageId: parsed.messageId,
                  ...(parsed.references !== undefined
                    ? { originalReferences: parsed.references }
                    : {}),
                  toAddress: senderAddress,
                  ...(parsed.subject !== undefined ? { subject: parsed.subject } : {}),
                });
              }

              handler(emailEvent);
            }
          } catch (e: unknown) {
            console.error("[channel-email] Failed to fetch/parse email:", e);
          }
        })();
      });

      // Start IDLE to listen for new messages
      void imap.idle().catch((e: unknown) => {
        console.error("[channel-email] IDLE failed:", e);
      });

      return () => {
        imap.removeAllListeners();
      };
    },

    normalize: normalizeEmail,
    platformSendStatus,
    ...(config.onHandlerError !== undefined ? { onHandlerError: config.onHandlerError } : {}),
    ...(config.queueWhenDisconnected !== undefined
      ? { queueWhenDisconnected: config.queueWhenDisconnected }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Client constructors (production only)
// ---------------------------------------------------------------------------

function createImapClient(config: EmailChannelConfig): ImapClientLike {
  const { ImapFlow } = require("imapflow") as {
    readonly ImapFlow: new (opts: Record<string, unknown>) => ImapClientLike;
  };
  return new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.tls ?? true,
    auth: config.imap.auth,
  });
}

function createNodemailerTransporter(config: EmailChannelConfig): TransporterLike {
  const nodemailer = require("nodemailer") as {
    readonly createTransport: (opts: Record<string, unknown>) => TransporterLike;
  };
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.tls ?? true,
    auth: config.smtp.auth,
  });
}

async function parseEmail(source: Buffer): Promise<ParsedEmail | null> {
  try {
    const { simpleParser } = require("mailparser") as {
      readonly simpleParser: (source: Buffer) => Promise<ParsedEmail>;
    };
    return await simpleParser(source);
  } catch (e: unknown) {
    console.error("[channel-email] Failed to parse email:", e);
    return null;
  }
}
