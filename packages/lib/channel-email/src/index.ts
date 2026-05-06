/**
 * @koi/channel-email — public exports.
 *
 * Email channel adapter: IMAP IDLE inbound + SMTP outbound with durable
 * RFC 5322 thread tracking and an explicit outbound state machine.
 */

export type { EmailConfig } from "./config.js";
export { validateEmailConfig } from "./config.js";

export type {
  EmailChannelAdapter,
  EmailDependencies,
  ImapClient,
  InboundEnvelope,
  MimeParser,
} from "./email-channel.js";
export { createEmailChannel } from "./email-channel.js";

export type { ParsedMail } from "./normalize.js";

export type { EmailErrorCode } from "./outbound-state-machine.js";

export type {
  SendResult,
  SmtpEnvelope,
  SmtpSendResult,
  SmtpTransport,
} from "./platform-send.js";

export type { ResolveOutcome, ResolveResult } from "./resolve-pending.js";

export type { IncomingHeaders } from "./threading.js";
