/**
 * Configuration types for the Email channel adapter.
 */

import type { InboundMessage } from "@koi/core";

/** IMAP connection configuration. */
export interface ImapConfig {
  readonly host: string;
  readonly port: number;
  readonly auth: {
    readonly user: string;
    readonly pass: string;
  };
  readonly tls?: boolean;
  readonly mailbox?: string;
}

/** SMTP connection configuration. */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly auth: {
    readonly user: string;
    readonly pass: string;
  };
  readonly tls?: boolean;
}

/** Configuration for the Email channel adapter. */
export interface EmailChannelConfig {
  readonly imap: ImapConfig;
  readonly smtp: SmtpConfig;
  /** Sender address for outbound emails. */
  readonly fromAddress: string;
  /** Display name for outbound emails. */
  readonly fromName?: string;
  /** Maximum email attachment size in MB. Oversized attachments trigger text fallback. */
  readonly mediaMaxMb?: number;
  /** Called when a registered message handler throws or rejects. */
  readonly onHandlerError?: (err: unknown, message: InboundMessage) => void;
  /** When true, send() buffers messages while disconnected. */
  readonly queueWhenDisconnected?: boolean;
  /** Test injection: ImapFlow client instance. */
  readonly _imapClient?: unknown;
  /** Test injection: Nodemailer transporter instance. */
  readonly _transporter?: unknown;
}
