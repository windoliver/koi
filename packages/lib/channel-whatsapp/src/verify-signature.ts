/**
 * @koi/channel-whatsapp — Meta webhook signature verification.
 *
 * Meta signs each webhook POST with HMAC-SHA256 over the raw request body
 * keyed by the app secret. The header `X-Hub-Signature-256` carries the
 * digest as `sha256=<hex>`. We compare timing-safe against our recomputed
 * digest.
 */

import { timingSafeEqual } from "node:crypto";

export type VerifySignatureInput = {
  readonly rawBody: string;
  readonly header: string | undefined | null;
  readonly appSecret: string;
};

export type VerifySignatureResult = { readonly ok: boolean };

const PREFIX = "sha256=";

export function verifyMetaSignature(input: VerifySignatureInput): VerifySignatureResult {
  const { rawBody, header, appSecret } = input;
  if (typeof header !== "string" || header.length === 0) return { ok: false };
  if (!header.startsWith(PREFIX)) return { ok: false };
  const provided = header.slice(PREFIX.length);

  const hasher = new Bun.CryptoHasher("sha256", appSecret);
  hasher.update(rawBody);
  const expected = hasher.digest("hex");

  if (expected.length !== provided.length) return { ok: false };
  const enc = new TextEncoder();
  const a = enc.encode(expected);
  const b = enc.encode(provided);
  if (a.length !== b.length) return { ok: false };
  return { ok: timingSafeEqual(a, b) };
}
