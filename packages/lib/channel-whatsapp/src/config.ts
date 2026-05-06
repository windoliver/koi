/**
 * @koi/channel-whatsapp — runtime config + validation.
 *
 * Validates Meta Cloud API credentials and operational defaults. All four
 * credential fields are required and must be non-empty; `graphBaseUrl` must
 * be an `https://` URL when provided.
 */

import { z } from "zod";

export type WhatsAppConfig = {
  readonly phoneNumberId: string;
  readonly accessToken: string;
  readonly verifyToken: string;
  readonly appSecret: string;
  readonly graphBaseUrl: string;
  readonly production: boolean;
  readonly handlerTimeoutMs: number;
  readonly commitTtlMs: number;
};

export type WhatsAppConfigError = {
  readonly code: "INVALID_CONFIG";
  readonly message: string;
};

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WhatsAppConfigError };

const HttpsUrl = z
  .string()
  .min(1)
  .refine((s) => s.startsWith("https://"), { message: "must be an https:// URL" });

const WhatsAppConfigSchema = z.object({
  phoneNumberId: z.string().min(1),
  accessToken: z.string().min(1),
  verifyToken: z.string().min(1),
  appSecret: z.string().min(1),
  graphBaseUrl: HttpsUrl.default("https://graph.facebook.com/v18.0"),
  production: z.boolean().default(false),
  handlerTimeoutMs: z.number().int().min(1).default(300_000),
  commitTtlMs: z
    .number()
    .int()
    .min(1)
    .default(7 * 24 * 60 * 60 * 1000),
});

export function validateWhatsAppConfig(input: unknown): Result<WhatsAppConfig> {
  const r = WhatsAppConfigSchema.safeParse(input);
  if (!r.success) {
    return { ok: false, error: { code: "INVALID_CONFIG", message: r.error.message } };
  }
  return { ok: true, value: r.data satisfies WhatsAppConfig };
}
