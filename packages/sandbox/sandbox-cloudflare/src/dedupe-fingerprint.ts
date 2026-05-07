/**
 * Spec-mandated dedupe fingerprint construction (single normative algorithm).
 *
 *   ownerIdBytes = utf8Bytes(ownerId + ":")
 *   payloadHash  = sha256_raw(utf8Bytes(jcs(payload)))   // 32 RAW bytes
 *   fp_bytes     = sha256_raw(concat(ownerIdBytes, payloadHash))
 *   fingerprint  = base16Lower(fp_bytes)
 *
 * `pairUUID` and `handlerCodeHash` are INTENTIONALLY excluded — see spec
 * "Dedupe state machine" / "Handler-version drift" sections.
 *
 * The same construction is used identically by host adapter, Cloudflare shim,
 * and Vercel shim. Helper is exported so all three call sites can import it.
 */

import { jcsCanonicalise } from "./jcs.js";

const HEX = "0123456789abcdef";

const bytesToHexLower = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    out += HEX[(b >> 4) & 0xf];
    out += HEX[b & 0xf];
  }
  return out;
};

const sha256Raw = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", ab);
  return new Uint8Array(digest);
};

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

export const computeDedupeFingerprint = async (
  ownerId: string,
  payload: unknown,
): Promise<string> => {
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    throw new TypeError("computeDedupeFingerprint: ownerId must be a non-empty string");
  }
  const enc = new TextEncoder();
  const ownerIdBytes = enc.encode(`${ownerId}:`);
  const payloadCanonical = enc.encode(jcsCanonicalise(payload));
  const payloadHash = await sha256Raw(payloadCanonical);
  const fpBytes = await sha256Raw(concatBytes(ownerIdBytes, payloadHash));
  return bytesToHexLower(fpBytes);
};
