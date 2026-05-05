/**
 * Federation config validation.
 */

import type { KoiError, Result } from "@koi/core";
import { validation } from "@koi/core";
import type { FederationConfig } from "./types.js";
import { DEFAULT_FEDERATION_CONFIG } from "./types.js";

/**
 * Validate and fill defaults for a federation config.
 * Returns a fully-populated FederationConfig or a validation error.
 */
export function validateFederationConfig(
  config: Partial<FederationConfig> & Pick<FederationConfig, "localZoneId">,
): Result<FederationConfig, KoiError> {
  if (typeof config.localZoneId !== "string" || config.localZoneId.length === 0) {
    return { ok: false, error: validation("localZoneId is required and must be non-empty") };
  }

  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_FEDERATION_CONFIG.pollIntervalMs;
  const offlineAfterFailures =
    config.offlineAfterFailures ?? DEFAULT_FEDERATION_CONFIG.offlineAfterFailures;

  if (pollIntervalMs <= 0) {
    return { ok: false, error: validation("pollIntervalMs must be positive") };
  }
  if (!Number.isInteger(offlineAfterFailures) || offlineAfterFailures <= 0) {
    return {
      ok: false,
      error: validation("offlineAfterFailures must be a positive integer"),
    };
  }

  return {
    ok: true,
    value: {
      localZoneId: config.localZoneId,
      remoteZones: config.remoteZones ?? [],
      pollIntervalMs,
      offlineAfterFailures,
    },
  };
}
