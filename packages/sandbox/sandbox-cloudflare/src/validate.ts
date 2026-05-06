import type { KoiError, Result } from "@koi/core";

import type { CloudflareAdapterConfig } from "./types.js";

const invalidConfig = (message: string, field: string): KoiError => ({
  code: "INVALID_CONFIG",
  message,
  retryable: false,
  context: { field },
});

/**
 * Reject empty/`"default"` `ownerId`, missing API token, missing DO namespace,
 * unknown integrity-verification mode. v1 admits ONLY workloadClass `"A"` —
 * the workload class is validated at `create()` against the per-call config,
 * not here.
 */
export const validateCloudflareAdapterConfig = (
  config: CloudflareAdapterConfig,
): Result<CloudflareAdapterConfig> => {
  if (config.accountId.trim().length === 0) {
    return { ok: false, error: invalidConfig("accountId is required", "accountId") };
  }
  if (config.apiToken.trim().length === 0) {
    return { ok: false, error: invalidConfig("apiToken is required", "apiToken") };
  }
  const ownerId = config.ownerId;
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    return {
      ok: false,
      error: invalidConfig("ownerId is required and must be non-empty", "ownerId"),
    };
  }
  if (ownerId === "default") {
    return {
      ok: false,
      error: invalidConfig('ownerId "default" is reserved', "ownerId"),
    };
  }
  if (config.dedupeDurableObjectNamespaceId.trim().length === 0) {
    return {
      ok: false,
      error: invalidConfig(
        "dedupeDurableObjectNamespaceId is required",
        "dedupeDurableObjectNamespaceId",
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
        `integrityVerification must be "cached" | "strict" | "async" (got "${String(config.integrityVerification)}")`,
        "integrityVerification",
      ),
    };
  }
  return { ok: true, value: config };
};
