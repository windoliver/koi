import { createHmac, timingSafeEqual } from "node:crypto";

export function computeSignature(secret: string, timestamp: string, rawBody: string): string {
  const h = createHmac("sha256", secret);
  h.update(`v0:${timestamp}:${rawBody}`);
  return `v0=${h.digest("hex")}`;
}

export function verifyHmac(
  secret: string,
  timestamp: string,
  rawBody: string,
  providedSignature: string,
): boolean {
  const computed = computeSignature(secret, timestamp, rawBody);
  if (computed.length !== providedSignature.length) return false;
  return timingSafeEqual(
    new Uint8Array(Buffer.from(computed)),
    new Uint8Array(Buffer.from(providedSignature)),
  );
}
