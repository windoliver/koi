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
  const conflictResolution =
    config.conflictResolution ?? DEFAULT_FEDERATION_CONFIG.conflictResolution;

  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    return {
      ok: false,
      error: validation("pollIntervalMs must be a positive finite number"),
    };
  }
  if (!Number.isInteger(offlineAfterFailures) || offlineAfterFailures <= 0) {
    return {
      ok: false,
      error: validation("offlineAfterFailures must be a positive integer"),
    };
  }
  if (
    conflictResolution !== "lww" &&
    conflictResolution !== "merge" &&
    conflictResolution !== "manual"
  ) {
    return {
      ok: false,
      error: validation("conflictResolution must be one of: lww, merge, manual"),
    };
  }

  return {
    ok: true,
    value: {
      localZoneId: config.localZoneId,
      remoteZones: config.remoteZones ?? [],
      pollIntervalMs,
      offlineAfterFailures,
      conflictResolution,
    },
  };
}
