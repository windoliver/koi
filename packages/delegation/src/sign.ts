/**
 * HMAC-SHA256 signing and verification for delegation grants.
 *
 * Uses Bun-native crypto (Node.js crypto module). Signature is computed
 * over a canonical JSON representation of the grant payload (excluding
 * the signature field itself).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { DelegationGrant } from "@koi/core";

/** All grant fields except `signature`, serialized in deterministic key order. */
type UnsignedGrant = Omit<DelegationGrant, "signature">;

/**
 * Recursively sorts object keys to produce deterministic JSON.
 * Handles nested objects and arrays correctly (unlike JSON.stringify
 * with a replacer array, which applies the same key filter to all levels).
 */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Produces a canonical JSON string from an unsigned grant.
 * Keys are recursively sorted to ensure deterministic output
 * regardless of property insertion order.
 */
function canonicalize(grant: UnsignedGrant): string {
  return JSON.stringify(sortKeys(grant));
}

/**
 * Signs an unsigned grant payload with HMAC-SHA256.
 * Returns the hex-encoded digest.
 */
export function signGrant(payload: UnsignedGrant, secret: string): string {
  const canonical = canonicalize(payload);
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

/**
 * Verifies a delegation grant's HMAC-SHA256 signature.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * Results are cached via WeakMap keyed by grant object reference.
 * Grants are immutable — same object reference always produces the same
 * result. The WeakMap is GC-friendly (entries are collected when the grant
 * object is no longer referenced).
 *
 * SHA256 always produces 64 hex chars. The length check is safe because
 * `expected` is always 64 chars — the early exit only triggers for
 * malformed signatures (not a timing oracle).
 */
const verifyCache = new WeakMap<DelegationGrant, boolean>();

export function verifySignature(grant: DelegationGrant, secret: string): boolean {
  const cached = verifyCache.get(grant);
  if (cached !== undefined) {
    return cached;
  }

  const result = verifySignatureUncached(grant, secret);
  verifyCache.set(grant, result);
  return result;
}

function verifySignatureUncached(grant: DelegationGrant, secret: string): boolean {
  const EXPECTED_HEX_LENGTH = 64;

  if (grant.signature.length !== EXPECTED_HEX_LENGTH) {
    return false;
  }

  const { signature: _sig, ...unsigned } = grant;
  const expected = signGrant(unsigned, secret);

  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(grant.signature, "hex"));
  } catch {
    return false;
  }
}
