import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

/**
 * Canonical validator for the payload returned by `transport.call("read", ...)`.
 *
 * Permission backend, audit sink, and `health()` probe all parse this same
 * shape — sharing the extractor closes the false-negative gap where a 200
 * with a malformed body would pass a probe but fail the consumer's parse.
 *
 * Accepts:
 *  - bare string
 *  - `{ content: string }` (without metadata)
 *  - `{ __type__: "bytes", data: "<base64>" }` (flat bytes envelope — Nexus default)
 *  - `{ content: <string | bytes-envelope>, ... }` (with `return_metadata=true`)
 *
 * Recurses into the nested `content` field so wrapped bytes envelopes work too.
 */
export function extractReadContent(value: unknown): Result<string, KoiError> {
  const decoded = decode(value);
  if (decoded !== undefined) return { ok: true, value: decoded };
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message: "unexpected NFS read response shape",
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

// Strict base64url-or-base64 alphabet — Buffer.from(...,'base64') silently
// drops invalid characters AND silently truncates malformed lengths (e.g.
// "A==" decodes to an empty buffer), masking content corruption. Validate
// the alphabet, validate the length is well-formed, then round-trip through
// the encoder so any silent transform is caught.
const BASE64_RE = /^[A-Za-z0-9+/_-]*={0,2}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function isWellFormedBase64Length(s: string): boolean {
  if (s.length === 0) return true;
  // Padded base64 (RFC 4648 §4) is always a multiple of 4 characters.
  if (s.endsWith("=")) return s.length % 4 === 0;
  // Unpadded base64url (§5): length mod 4 of 1 is impossible (would imply
  // 6 bits of payload, which cannot encode any whole byte).
  return s.length % 4 !== 1;
}

function normalizeBase64(s: string): string {
  return s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
}

function decode(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.__type__ === "bytes" && typeof obj.data === "string") {
    if (!BASE64_RE.test(obj.data)) return undefined;
    if (!isWellFormedBase64Length(obj.data)) return undefined;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(obj.data, "base64");
    } catch {
      return undefined;
    }
    // Round-trip: re-encode and compare ignoring padding/alphabet variant.
    // Catches anything Buffer.from silently truncated or transformed.
    const reencoded = normalizeBase64(bytes.toString("base64"));
    if (reencoded !== normalizeBase64(obj.data)) return undefined;
    try {
      return UTF8_DECODER.decode(bytes);
    } catch {
      return undefined;
    }
  }
  if (typeof obj.content === "string") return obj.content;
  if (obj.content !== undefined) return decode(obj.content);
  return undefined;
}
