/**
 * BrickDescriptor for @koi/channel-email.
 *
 * Enables manifest auto-resolution for the Email channel.
 * IMAP and SMTP settings are read from environment variables.
 */

import type { ChannelAdapter } from "@koi/core";
import type { BrickDescriptor, ResolutionContext } from "@koi/resolve";
import { validateOptionalDescriptorOptions } from "@koi/resolve";
import { createEmailChannel } from "./email-channel.js";

/**
 * Descriptor for Email channel adapter.
 * Exported for registration with createRegistry().
 */
export const descriptor: BrickDescriptor<ChannelAdapter> = {
  kind: "channel",
  name: "@koi/channel-email",
  aliases: ["email"],
  optionsValidator: (input) => validateOptionalDescriptorOptions(input, "Email channel"),
  factory(options, context: ResolutionContext): ChannelAdapter {
    const opts = options as Readonly<Record<string, unknown>>;

    const imapHost = (opts.imapHost as string | undefined) ?? context.env.EMAIL_IMAP_HOST;
    const smtpHost = (opts.smtpHost as string | undefined) ?? context.env.EMAIL_SMTP_HOST;
    const user = (opts.user as string | undefined) ?? context.env.EMAIL_USER;
    const pass = (opts.pass as string | undefined) ?? context.env.EMAIL_PASS;
    const fromAddress = (opts.fromAddress as string | undefined) ?? context.env.EMAIL_FROM;

    if (
      imapHost === undefined ||
      smtpHost === undefined ||
      user === undefined ||
      pass === undefined ||
      fromAddress === undefined
    ) {
      throw new Error(
        "Missing email configuration. Required: EMAIL_IMAP_HOST, EMAIL_SMTP_HOST, EMAIL_USER, EMAIL_PASS, EMAIL_FROM",
      );
    }

    return createEmailChannel({
      imap: {
        host: imapHost,
        port: typeof opts.imapPort === "number" ? opts.imapPort : 993,
        auth: { user, pass },
      },
      smtp: {
        host: smtpHost,
        port: typeof opts.smtpPort === "number" ? opts.smtpPort : 587,
        auth: { user, pass },
      },
      fromAddress,
      ...(typeof opts.fromName === "string" ? { fromName: opts.fromName } : {}),
    });
  },
};
