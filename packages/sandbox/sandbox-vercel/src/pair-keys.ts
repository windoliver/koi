/**
 * Per-pair Ed25519 keypair utilities.
 *
 * Spec § "Worker A → Worker B authentication": every Vercel deploy generates
 * a fresh Ed25519 keypair. The PRIVATE signing key is provisioned to Worker A
 * only; the PUBLIC verify key is provisioned to Worker B only. Worker B
 * cannot forge — exfiltration of its env yields the verify key, not the
 * signing key. Symmetric HMAC and `x-vercel-signature` are explicitly NOT
 * used (operator code in B could exfiltrate a shared secret).
 */

import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;

export interface PairKeypair {
  /** Spki PEM for the public verify key (provisioned to Worker B only). */
  readonly verifyKeyPem: string;
  /** Pkcs8 PEM for the private signing key (provisioned to Worker A only). */
  readonly signingKeyPem: string;
}

const toBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  return globalThis.btoa(s);
};

const wrapPem = (label: string, b64: string): string => {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};

/** Generate a fresh Ed25519 keypair as PEM strings. Used at create() time. */
export const generatePairKeypair = async (): Promise<PairKeypair> => {
  const pair = (await subtle.generateKey(
    { name: "Ed25519" } as unknown as Parameters<typeof subtle.generateKey>[0],
    true,
    ["sign", "verify"],
  )) as unknown as CryptoKeyPair;
  const spki = await subtle.exportKey("spki", pair.publicKey);
  const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);
  return {
    verifyKeyPem: wrapPem("PUBLIC KEY", toBase64(spki)),
    signingKeyPem: wrapPem("PRIVATE KEY", toBase64(pkcs8)),
  };
};

const pemToBytes = (pem: string): Uint8Array<ArrayBuffer> => {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = globalThis.atob(body);
  const ab = new ArrayBuffer(bin.length);
  const out = new Uint8Array(ab);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  return globalThis.btoa(s);
};

/**
 * Canonical signing string per spec: method, path, operationId, requestId,
 * nonce, timestamp (sec), SHA-256 of body. Joined by `\n`. Both Worker A and
 * Worker B compute this identically; Worker B verifies the signature.
 */
export interface CanonicalSignInput {
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
  readonly requestId: string;
  readonly nonce: string;
  readonly timestampSec: number;
  readonly bodyBytes: Uint8Array;
}

export const buildCanonicalSigningString = async (input: CanonicalSignInput): Promise<string> => {
  const ab = new ArrayBuffer(input.bodyBytes.byteLength);
  new Uint8Array(ab).set(input.bodyBytes);
  const digest = await subtle.digest("SHA-256", ab);
  const bodyHashB64 = bytesToBase64(new Uint8Array(digest));
  return [
    input.method.toUpperCase(),
    input.path,
    input.operationId,
    input.requestId,
    input.nonce,
    String(input.timestampSec),
    bodyHashB64,
  ].join("\n");
};

/** Sign with the per-pair Ed25519 private key (Worker A side). */
export const signRequest = async (signingKeyPem: string, canonical: string): Promise<string> => {
  const key = await subtle.importKey(
    "pkcs8",
    pemToBytes(signingKeyPem),
    { name: "Ed25519" } as unknown as Parameters<typeof subtle.importKey>[2],
    false,
    ["sign"],
  );
  const sig = await subtle.sign("Ed25519", key, new TextEncoder().encode(canonical));
  return bytesToBase64(new Uint8Array(sig));
};

/** Verify a per-pair signature (Worker B side). */
export const verifyRequest = async (
  verifyKeyPem: string,
  canonical: string,
  signatureB64: string,
): Promise<boolean> => {
  const key = await subtle.importKey(
    "spki",
    pemToBytes(verifyKeyPem),
    { name: "Ed25519" } as unknown as Parameters<typeof subtle.importKey>[2],
    false,
    ["verify"],
  );
  const bin = globalThis.atob(signatureB64);
  const sigBuf = new ArrayBuffer(bin.length);
  const sig = new Uint8Array(sigBuf);
  for (let i = 0; i < bin.length; i++) sig[i] = bin.charCodeAt(i);
  return subtle.verify("Ed25519", key, sig, new TextEncoder().encode(canonical));
};
