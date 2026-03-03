/**
 * PII replacement strategies — 4 pure functions for handling detected PII.
 */

import type { PIIMatch } from "./types.js";

/** Hasher interface matching Bun.CryptoHasher's sync API. */
export interface PIIHasher {
  readonly update: (data: string) => PIIHasher;
  readonly digest: (encoding: "hex") => string;
}

/** Factory for creating HMAC hashers. */
export type PIIHasherFactory = () => PIIHasher;

/** Redact: replace with `[REDACTED_<KIND>]`. */
export function applyRedact(match: PIIMatch): string {
  return `[REDACTED_${match.kind.toUpperCase()}]`;
}

/** Mask: per-type partial masking that preserves some useful info. */
export function applyMask(match: PIIMatch): string {
  switch (match.kind) {
    case "email": {
      const atIndex = match.text.indexOf("@");
      if (atIndex <= 0) return `[MASKED_EMAIL]`;
      const domain = match.text.slice(atIndex);
      return `${match.text[0]}***${domain}`;
    }
    case "credit_card": {
      const digits = match.text.replace(/\D/g, "");
      const last4 = digits.slice(-4);
      return `****-****-****-${last4}`;
    }
    case "ip": {
      const octets = match.text.split(".");
      const lastOctet = octets[octets.length - 1] ?? "0";
      return `***.***.***.${lastOctet}`;
    }
    case "mac": {
      // Preserve OUI (first 3 octets), mask last 3
      const sep = match.text.includes(":") ? ":" : "-";
      const parts = match.text.split(/[:-]/);
      const oui = parts.slice(0, 3).join(sep);
      return `${oui}${sep}**${sep}**${sep}**`;
    }
    case "ssn": {
      // Preserve last 4 digits
      const last4 = match.text.slice(-4);
      return `***-**-${last4}`;
    }
    case "phone": {
      // Preserve last 4 digits
      const digits = match.text.replace(/\D/g, "");
      const last4 = digits.slice(-4);
      return `***-***-${last4}`;
    }
    default:
      return `[MASKED_${match.kind.toUpperCase()}]`;
  }
}

/** Hash: produce `<kind:16-char-hex>` using HMAC-SHA256. */
export function applyHash(match: PIIMatch, createHasher: PIIHasherFactory): string {
  const hex = createHasher().update(match.text).digest("hex").slice(0, 16);
  return `<${match.kind}:${hex}>`;
}
