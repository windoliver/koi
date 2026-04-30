import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

/**
 * Canonical validator for the payload returned by `transport.call("read", ...)`.
 *
 * Permission backend, audit sink, and `health()` probe all parse this same
 * shape — sharing the extractor closes the false-negative gap where a 200
 * with a malformed body would pass a probe but fail the consumer's parse.
 *
 * Accepts either a bare string or `{ content: string }`.
 */
export function extractReadContent(value: unknown): Result<string, KoiError> {
  if (typeof value === "string") {
    return { ok: true, value };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    typeof (value as { content: unknown }).content === "string"
  ) {
    return { ok: true, value: (value as { content: string }).content };
  }
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message: "unexpected NFS read response shape",
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}
