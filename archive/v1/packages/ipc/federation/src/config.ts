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
  if (!config.localZoneId) {
    return { ok: false, error: validation("localZoneId is required") };
  }

  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_FEDERATION_CONFIG.pollIntervalMs;
  const minPollIntervalMs = config.minPollIntervalMs ?? DEFAULT_FEDERATION_CONFIG.minPollIntervalMs;
  const maxPollIntervalMs = config.maxPollIntervalMs ?? DEFAULT_FEDERATION_CONFIG.maxPollIntervalMs;
  const snapshotThreshold = config.snapshotThreshold ?? DEFAULT_FEDERATION_CONFIG.snapshotThreshold;
  const clockPruneAfterMs = config.clockPruneAfterMs ?? DEFAULT_FEDERATION_CONFIG.clockPruneAfterMs;

  if (pollIntervalMs <= 0) {
    return { ok: false, error: validation("pollIntervalMs must be positive") };
  }
  if (minPollIntervalMs <= 0) {
    return { ok: false, error: validation("minPollIntervalMs must be positive") };
  }
  if (maxPollIntervalMs <= 0) {
    return { ok: false, error: validation("maxPollIntervalMs must be positive") };
  }
  if (minPollIntervalMs > maxPollIntervalMs) {
    return {
      ok: false,
      error: validation("minPollIntervalMs must be <= maxPollIntervalMs"),
    };
  }
  if (snapshotThreshold <= 0) {
    return { ok: false, error: validation("snapshotThreshold must be positive") };
  }
  if (clockPruneAfterMs <= 0) {
    return { ok: false, error: validation("clockPruneAfterMs must be positive") };
  }

  return {
    ok: true,
    value: {
      localZoneId: config.localZoneId,
      remoteZones: config.remoteZones ?? [],
      pollIntervalMs,
      minPollIntervalMs,
      maxPollIntervalMs,
      snapshotThreshold,
      clockPruneAfterMs,
      conflictResolution: config.conflictResolution ?? DEFAULT_FEDERATION_CONFIG.conflictResolution,
    },
  };
}
