import { createHmac, timingSafeEqual } from "node:crypto";
import type { CapabilityToken } from "@koi/core";
import { serializeForSigning } from "./canonical.js";

export function signHmac(token: CapabilityToken, secret: Uint8Array): string {
  const payload = serializeForSigning(token);
  const digest = createHmac("sha256", secret).update(payload).digest();
  return digest.toString("base64");
}

export function verifyHmac(token: CapabilityToken, secret: Uint8Array): boolean {
  if (token.proof.kind !== "hmac-sha256") return false;
  const expected = createHmac("sha256", secret).update(serializeForSigning(token)).digest();
  let actual: Uint8Array;
  try {
    actual = new Uint8Array(Buffer.from(token.proof.digest, "base64"));
  } catch {
    return false;
  }
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(new Uint8Array(expected), actual);
}
