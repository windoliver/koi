import type { KoiError, Result } from "@koi/core";

import type { VercelAdapterConfig } from "./types.js";

const invalidConfig = (message: string, field: string): KoiError => ({
  code: "INVALID_CONFIG",
  message,
  retryable: false,
  context: { field },
});

// Rejects ":" (KV key delimiter), any whitespace, and any control char.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional rejection
const OWNER_ID_RESERVED_RE = /[:\s\x00-\x1f\x7f]/;

export const validateVercelAdapterConfig = (
  config: VercelAdapterConfig,
): Result<VercelAdapterConfig> => {
  if (config.dedupeKvUrl.trim().length === 0) {
    return { ok: false, error: invalidConfig("dedupeKvUrl is required", "dedupeKvUrl") };
  }
  if (config.dedupeKvToken.trim().length === 0) {
    return { ok: false, error: invalidConfig("dedupeKvToken is required", "dedupeKvToken") };
  }
  const ownerId = config.ownerId;
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    return {
      ok: false,
      error: invalidConfig("ownerId is required and must be non-empty", "ownerId"),
    };
  }
  if (ownerId === "default") {
    return { ok: false, error: invalidConfig('ownerId "default" is reserved', "ownerId") };
  }
  if (OWNER_ID_RESERVED_RE.test(ownerId)) {
    return {
      ok: false,
      error: invalidConfig(
        'ownerId must not contain ":", whitespace, or control characters',
        "ownerId",
      ),
    };
  }
  if (
    config.integrityVerification !== undefined &&
    config.integrityVerification !== "cached" &&
    config.integrityVerification !== "strict" &&
    config.integrityVerification !== "async"
  ) {
    return {
      ok: false,
      error: invalidConfig(
        `integrityVerification must be "cached" | "strict" | "async"`,
        "integrityVerification",
      ),
    };
  }
  return { ok: true, value: config };
};
