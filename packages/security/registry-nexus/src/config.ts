/**
 * Configuration types and validation for the Nexus-backed AgentRegistry.
 */

import type { KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

/** Configuration for the Nexus-backed AgentRegistry. */
export interface NexusRegistryConfig {
  /** Pre-configured transport. Caller owns the lifecycle. */
  readonly transport: NexusTransport;
  /** Optional Nexus zone scope for agent listing. */
  readonly zoneId?: string | undefined;
  /** Poll interval in milliseconds. 0 = disabled. Default: 10_000. */
  readonly pollIntervalMs?: number | undefined;
  /** Startup timeout in milliseconds for initial agent list load. Default: 30_000. */
  readonly startupTimeoutMs?: number | undefined;
  /** Maximum number of entries in the local projection cache. Default: 10_000. */
  readonly maxEntries?: number | undefined;
}

/** Default configuration values. */
export const DEFAULT_NEXUS_REGISTRY_CONFIG = {
  pollIntervalMs: 10_000,
  startupTimeoutMs: 30_000,
  maxEntries: 10_000,
} as const;

/** Validate a NexusRegistryConfig. Returns a typed error on failure. */
export function validateNexusRegistryConfig(
  config: NexusRegistryConfig,
): Result<NexusRegistryConfig, KoiError> {
  // Reject NaN/Infinity/fractional numeric config — these silently
  // disable safety limits (e.g. NaN maxEntries makes capacity checks
  // always-false, NaN pollIntervalMs spins the loop, NaN
  // startupTimeoutMs collapses the timeout).
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_NEXUS_REGISTRY_CONFIG.pollIntervalMs;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "pollIntervalMs must be a non-negative integer",
        retryable: false,
      },
    };
  }

  const startupTimeoutMs =
    config.startupTimeoutMs ?? DEFAULT_NEXUS_REGISTRY_CONFIG.startupTimeoutMs;
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs <= 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "startupTimeoutMs must be a positive integer",
        retryable: false,
      },
    };
  }

  const maxEntries = config.maxEntries ?? DEFAULT_NEXUS_REGISTRY_CONFIG.maxEntries;
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "maxEntries must be a positive integer",
        retryable: false,
      },
    };
  }

  return { ok: true, value: config };
}
