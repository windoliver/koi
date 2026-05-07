/**
 * @koi/channel-email — runtime config + validation.
 */

import { z } from "zod";

export type ImapConfig = {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly mailbox: string;
  readonly tls: boolean;
};

export type SmtpConfig = {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
  readonly tls: boolean;
};

export type EmailConfig = {
  readonly imap: ImapConfig;
  readonly smtp: SmtpConfig;
  readonly pollInterval: number;
  readonly autoRetryAfterDataAck: boolean;
  readonly production: boolean;
  readonly handlerTimeoutMs: number;
  readonly commitTtlMs: number;
};

export type EmailConfigError = {
  readonly code: "INVALID_CONFIG";
  readonly message: string;
};

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: EmailConfigError };

const ImapConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  pass: z.string().min(1),
  mailbox: z.string().min(1).default("INBOX"),
  tls: z.boolean().default(true),
});

const SmtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  pass: z.string().min(1),
  from: z.string().refine((s) => /.+@.+\..+/.test(s), { message: "invalid email" }),
  tls: z.boolean().default(true),
});

const EmailConfigSchema = z.object({
  imap: ImapConfigSchema,
  smtp: SmtpConfigSchema,
  pollInterval: z.number().int().min(1).default(60_000),
  autoRetryAfterDataAck: z.boolean().default(false),
  production: z.boolean().default(false),
  handlerTimeoutMs: z.number().int().min(1).default(300_000),
  commitTtlMs: z.number().int().min(1).default(Number.MAX_SAFE_INTEGER),
});

export function validateEmailConfig(input: unknown): Result<EmailConfig> {
  const r = EmailConfigSchema.safeParse(input);
  if (r.success) return { ok: true, value: r.data satisfies EmailConfig };
  return { ok: false, error: { code: "INVALID_CONFIG", message: r.error.message } };
}
