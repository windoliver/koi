import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compute the v0 signature over the raw request body. `rawBody` may be either
 * a UTF-8 string (legacy callers) or a Uint8Array of the original bytes. When
 * a string is passed, it is hashed as the encoded UTF-8 bytes — which matches
 * the on-the-wire bytes only for valid-UTF-8 payloads.
 *
 * The byte form is the security-correct path: HMAC must cover the exact bytes
 * the producer signed, not a re-encoded representation.
 */
export function computeSignature(
  secret: string,
  timestamp: string,
  rawBody: string | Uint8Array,
): string {
  const h = createHmac("sha256", secret);
  // Two-stage update avoids any concat allocation and keeps the byte form pure.
  h.update(`v0:${timestamp}:`);
  h.update(rawBody);
  return `v0=${h.digest("hex")}`;
}

export function verifyHmac(
  secret: string,
  timestamp: string,
  rawBody: string | Uint8Array,
  providedSignature: string,
): boolean {
  const computed = computeSignature(secret, timestamp, rawBody);
  if (computed.length !== providedSignature.length) return false;
  return timingSafeEqual(
    new Uint8Array(Buffer.from(computed)),
    new Uint8Array(Buffer.from(providedSignature)),
  );
}
