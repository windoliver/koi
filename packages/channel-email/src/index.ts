/**
 * @koi/channel-email — IMAP/SMTP email channel adapter.
 *
 * Creates a ChannelAdapter for email using ImapFlow (IMAP IDLE for receive)
 * and Nodemailer (SMTP for send).
 */

export type { EmailChannelConfig, ImapConfig, SmtpConfig } from "./config.js";
export { descriptor } from "./descriptor.js";
export type { EmailChannelAdapter } from "./email-channel.js";
export { createEmailChannel } from "./email-channel.js";
export { mapTextToHtml } from "./format.js";
